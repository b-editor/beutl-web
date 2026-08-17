import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import {
  AiProviderError,
  translateSegments,
} from "../../ai/openrouter";
import { loadAiSettings } from "../../ai/settings";
import {
  isUploadLimitExceeded,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
  parseJsonWithBodyLimit,
} from "../../ai/upload-limits";
import { AI_JOB_FAILURE_MESSAGES } from "../../ai/job-errors";
import { readAiJsonResult, saveAiJsonResult } from "../../ai/storage";
import { getAiJobResultFile } from "@beutl/db";
import { getAiRequestIdentity } from "../../ai/request-integrity";
import {
  isIso6391LanguageCode,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  SAFE_SEGMENT_ID_PATTERN,
} from "../../ai/subtitle-validation";


const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isIso6391LanguageCode);

const translationContextSchema = z
  .object({
    groupId: z.string().regex(SAFE_SEGMENT_ID_PATTERN),
    partIndex: z.number().int().nonnegative().max(MAX_TRANSLATION_SEGMENTS - 1),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
  })
  .strict()
  .refine((value) => value.end > value.start, {
    message: "Translation context must have a positive duration",
    path: ["end"],
  });

const translationSegmentSchema = z
  .object({
    id: z.string().regex(SAFE_SEGMENT_ID_PATTERN),
    text: z
      .string()
      .min(1)
      .max(MAX_TRANSLATION_CHARACTERS)
      .refine((value) => value.trim().length > 0),
    context: translationContextSchema.optional(),
  })
  .strict();

const translationRequestSchema = z
  .object({
    sourceLanguage: languageSchema.optional(),
    targetLanguage: languageSchema,
    segments: z
      .array(translationSegmentSchema)
      .min(1)
      .max(MAX_TRANSLATION_SEGMENTS),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    let characterCount = 0;

    for (const [index, segment] of value.segments.entries()) {
      if (ids.has(segment.id)) {
        context.addIssue({
          code: "custom",
          message: "Translation segment IDs must be unique",
          path: ["segments", index, "id"],
        });
      }
      ids.add(segment.id);
      characterCount += segment.text.length;
    }

    if (characterCount > MAX_TRANSLATION_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: "Translation text is too long",
        path: ["segments"],
      });
    }
  });

const storedTranslationResultSchema = z.object({
  version: z.literal(1),
  kind: z.literal("translation"),
  segments: z.array(z.object({
    id: z.string().regex(SAFE_SEGMENT_ID_PATTERN),
    text: z.string().refine((value) => value.trim().length > 0),
  }).passthrough()),
}).passthrough();

function isJsonRequest(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() === "application/json"
  );
}

const app = new Hono().post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }

  let requestBody: unknown;
  try {
    if (!isJsonRequest(c.req.raw)) {
      throw new Error("Expected an application/json request");
    }
    requestBody = await parseJsonWithBodyLimit<unknown>(
      c.req,
      MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
    );
  } catch (error) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: isUploadLimitExceeded(error) ? 413 : 400,
    });
  }

  const parsedRequest = translationRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }

  const { sourceLanguage, targetLanguage, segments } = parsedRequest.data;
  const requestIdentity = await getAiRequestIdentity({
    request: c.req.raw,
    operation: "subtitle.translate",
    input: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segments,
    },
  });
  if (!requestIdentity) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
  const characterCount = segments.reduce(
    (total, segment) => total + segment.text.length,
    0,
  );
  const settings = await loadAiSettings();
  const usageUnits =
    settings.getPrice("subtitle.translate") *
    Math.max(1, Math.ceil(characterCount / 1_000));
  const reservation = await createReservedAiJob({
    userId,
    kind: "translation",
    provider: "openrouter",
    status: "running",
    inputParams: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segmentCount: segments.length,
      characterCount,
    },
    usageUnits,
    ...requestIdentity,
  });
  if (!reservation.ok) {
    return c.json(await apiErrorResponse(reservation.errorCode), {
      status: reservation.status,
    });
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      const fileRecord = await getAiJobResultFile({
        jobId: job.id,
        userId,
      });
      if (fileRecord) {
        try {
          const stored = storedTranslationResultSchema.parse(
            await readAiJsonResult({ objectKey: fileRecord.objectKey }),
          );
          const translatedById = new Map(
            stored.segments.map((segment) => [segment.id, segment.text]),
          );
          if (
            translatedById.size === segments.length &&
            segments.every((segment) => translatedById.has(segment.id))
          ) {
            return c.json({
              jobId: job.id,
              segments: segments.map((segment) => ({
                id: segment.id,
                text: translatedById.get(segment.id)!,
              })),
            });
          }
        } catch (error) {
          console.error("Failed to recover AI translation result", error);
        }
      }
      return c.json(await apiErrorResponse("aiProviderError"), {
        status: 500,
      });
    }
    if (job.status === "queued" ||
      job.status === "running" ||
      job.status === "finalizing") {
      return c.json(await apiErrorResponse("aiRequestInProgress"), {
        status: 409,
      });
    }
    return c.json(await apiErrorResponse("aiProviderError"), { status: 500 });
  }

  try {
    const translatedSegments = await translateSegments({
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segments: segments.map(({ id, text }) => ({ id, text })),
      model: settings.getModel("subtitle.translate"),
      signal: c.req.raw.signal,
    });
    const contextById = new Map(
      segments.map((segment) => [segment.id, segment.context] as const),
    );
    await saveAiJsonResult({
      jobId: job.id,
      userId,
      filename: `translation-${job.id}.json`,
      result: {
        version: 1,
        kind: "translation",
        ...(sourceLanguage ? { sourceLanguage } : {}),
        targetLanguage,
        segments: translatedSegments.map((segment) => {
          const context = contextById.get(segment.id);
          return context ? { ...segment, context } : segment;
        }),
      },
    });

    return c.json({
      jobId: job.id,
      segments: translatedSegments,
    });
  } catch (error) {
    await failAiJobAndRefundUsage({
      userId,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.translation,
    });
    if (error instanceof AiProviderError) {
      return c.json(await apiErrorResponse("aiProviderError"), {
        status: 500,
      });
    }
    console.error("Failed to persist AI translation result", error);
    return c.json(await apiErrorResponse("aiProviderError"), {
      status: 500,
    });
  }
});

export default app;
