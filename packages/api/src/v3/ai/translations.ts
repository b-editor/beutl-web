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
import { saveAiJsonResult } from "../../ai/storage";

const MAX_TRANSLATION_SEGMENTS = 200;
const MAX_TRANSLATION_CHARACTERS = 20_000;
const SAFE_SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const iso6391LanguageCodes = new Set(
  [
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs",
    "ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff",
    "fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id",
    "ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku",
    "kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my",
    "na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu",
    "rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv",
    "sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo",
    "wa wo xh yi yo za zh zu",
  ].flatMap((group) => group.split(" ")),
);

const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => iso6391LanguageCodes.has(value));

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
  });
  if (!reservation.ok) {
    return c.json(await apiErrorResponse(reservation.errorCode), {
      status: reservation.status,
    });
  }
  const { job } = reservation;

  try {
    const translatedSegments = await translateSegments({
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segments: segments.map(({ id, text }) => ({ id, text })),
      model: settings.getModel("subtitle.translate"),
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
