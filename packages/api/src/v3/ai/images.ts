import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import {
  loadAiImageModelCapabilities,
  unsupportedImageRequestReason,
} from "../../ai/image-model-capabilities";
import { getEntitlements } from "../../ai/entitlements";
import {
  fileExceedsUploadLimit,
  isUploadLimitExceeded,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_PROMPT_LENGTH,
  parseBodyWithUploadLimit,
  parseJsonWithBodyLimit,
} from "../../ai/upload-limits";
import {
  AiProviderError,
  editImage,
  generateImage,
} from "../../ai/openrouter";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_TASKS,
  AI_LEGACY_IMAGE_SIZES,
  AI_MAX_IMAGE_REFERENCES,
  AI_MAX_SEED,
  AI_MIN_SEED,
  MAX_MODEL_ID_LENGTH,
  aiImageEditTaskRequiresPrompt,
  aspectRatioOfLegacyImageSize,
  type AiImageAspectRatio,
  type AiImageEditTask,
} from "@beutl/core";
import { saveAiImage } from "../../ai/storage";
import {
  decodeGeneratedImageBase64,
  inspectGeneratedImage,
  InvalidGeneratedImageError,
} from "../../ai/image-validation";
import {
  validateAiInputImage,
  type AiInputImageMimeType,
} from "../../ai/input-image-validation";
import { getContentUrl } from "../../content-url";
import { AI_JOB_FAILURE_MESSAGES } from "../../ai/job-errors";
import { getAiRequestIdentity, sha256Hex } from "../../ai/request-integrity";

// `size` is the field this endpoint shipped with; `aspectRatio` is what the
// provider actually speaks and what a 16:9 or vertical request needs. Exactly
// one of them is required, so an existing client keeps working unchanged and a
// new one never has to guess which fixed size means which shape.
const generateSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
    size: z.enum(AI_LEGACY_IMAGE_SIZES).optional(),
    aspectRatio: z.enum(AI_IMAGE_ASPECT_RATIOS).optional(),
    background: z.enum(AI_IMAGE_BACKGROUNDS).optional(),
    seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
    model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
  })
  .strict()
  .refine(
    (value) => (value.size === undefined) !== (value.aspectRatio === undefined),
    { message: "Exactly one of size or aspectRatio is required" },
  );

const editTasks = AI_IMAGE_EDIT_TASKS;
type EditTask = AiImageEditTask;

const editFieldsSchema = z.object({
  task: z.enum(editTasks),
  prompt: z.string().trim().max(MAX_AI_PROMPT_LENGTH).optional(),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
}).strict();

// v3 endpoints live in packages/api because production routes /api/v3/* to
// the standalone beutl-web-api Worker (ADR 0002). R2 is injected by the host
// Worker so this package remains runtime-independent.
// Usage consumption and entitlement checks live in shared packages/api logic
// (createReservedAiJob / getEntitlements),
// and can also be reused by the Web route during rollback.

const supportedInputImageTypes = new Set<AiInputImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isMultipartRequest(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data") === true
  );
}

// An omitted multipart field and an empty one both mean "use the default".
// Forwarding "" fails the enums, and Number("") is 0 — a valid seed, which
// would pin every such generation to one deterministic result.
function optionalMultipartField(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function decodeImageResult(
  result: { b64Json: string; mediaType: string },
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  try {
    const bytes = decodeGeneratedImageBase64(result.b64Json);
    const metadata = await inspectGeneratedImage(bytes, result.mediaType);
    return {
      bytes,
      mimeType: metadata.mimeType,
    };
  } catch (cause) {
    if (cause instanceof InvalidGeneratedImageError) {
      throw new AiProviderError("OpenRouter returned invalid image bytes", {
        cause,
      });
    }
    throw cause;
  }
}

const app = new Hono()
  .post("/", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    // A reference image turns this into image-to-image, which needs multipart.
    // A request without one stays exactly the JSON call it has always been.
    const multipart = isMultipartRequest(c.req.raw);
    let rawBody: unknown;
    // Several pictures may guide one generation; the models take between three
    // and sixteen and the price is set for AI_MAX_IMAGE_REFERENCES. A single
    // "reference" field still works, which is what every existing client sends.
    let referenceFiles: File[] = [];
    if (multipart) {
      let body: Awaited<ReturnType<typeof c.req.parseBody>>;
      try {
        body = await parseBodyWithUploadLimit(c.req, MAX_AI_IMAGE_UPLOAD_BYTES);
      } catch (error) {
        if (isUploadLimitExceeded(error)) {
          return c.json(await apiErrorResponse("fileIsTooLarge"), {
            status: 413,
          });
        }
        throw error;
      }
      const listed = body["reference[]"];
      referenceFiles = [
        body["reference"],
        ...(Array.isArray(listed) ? listed : [listed]),
      ].filter((value): value is File => value instanceof File && value.size > 0);
      if (referenceFiles.length > AI_MAX_IMAGE_REFERENCES) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 400,
        });
      }
      if (
        referenceFiles.some((file) =>
          fileExceedsUploadLimit(file, MAX_AI_IMAGE_UPLOAD_BYTES),
        )
      ) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
      const size = optionalMultipartField(body, "size");
      const aspectRatioField = optionalMultipartField(body, "aspectRatio");
      const background = optionalMultipartField(body, "background");
      const seedField = optionalMultipartField(body, "seed");
      const modelField = optionalMultipartField(body, "model");
      rawBody = {
        prompt: body["prompt"],
        ...(size === undefined ? {} : { size }),
        ...(aspectRatioField === undefined
          ? {}
          : { aspectRatio: aspectRatioField }),
        ...(background === undefined ? {} : { background }),
        ...(seedField === undefined ? {} : { seed: Number(seedField) }),
        ...(modelField === undefined ? {} : { model: modelField }),
      };
    } else {
      try {
        rawBody = await parseJsonWithBodyLimit<unknown>(c.req);
      } catch (error) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: isUploadLimitExceeded(error) ? 413 : 400,
        });
      }
    }
    const parsedBody = generateSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const { prompt, size, background, seed } = parsedBody.data;
    const aspectRatio: AiImageAspectRatio =
      parsedBody.data.aspectRatio ??
      (aspectRatioOfLegacyImageSize(size as string) as AiImageAspectRatio);

    const validated = await Promise.all(
      referenceFiles.map((file) =>
        validateAiInputImage(file, supportedInputImageTypes),
      ),
    );
    const references = validated.filter(
      (reference): reference is NonNullable<typeof reference> =>
        reference !== null,
    );
    if (references.length !== referenceFiles.length) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    // Resolved before the fingerprint: the same prompt on a different model is a
    // different request, and the price must come from the same row the provider
    // call will use.
    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve("image.generate", parsedBody.data.model);
    if (!selectedModel) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    // Refused here rather than by the provider after the usage is reserved:
    // GPT Image-1 takes only 1:1, 3:2 and 2:3, and a rejection that arrives
    // after the reservation reads as a provider outage.
    if (
      unsupportedImageRequestReason(
        (await loadAiImageModelCapabilities([selectedModel.modelId])).get(
          selectedModel.modelId,
        ),
        {
          aspectRatio,
          ...(background ? { background } : {}),
          ...(seed === undefined ? {} : { seed }),
          referenceImages: references.length,
        },
      )
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }

    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "image.generate",
      input: {
        prompt,
        aspectRatio,
        model: selectedModel.modelId,
        // "auto" is the absence of a choice, so a caller that sends it and one
        // that omits it must fingerprint alike; otherwise a retry under the
        // same key is refused as a conflict and cannot reach the job it paid
        // for. The stored inputParams and the Server Action normalize it too.
        ...(background && background !== "auto" ? { background } : {}),
        ...(seed === undefined ? {} : { seed }),
        // Every picture is part of what makes this request the request it is:
        // the same prompt guided by different pictures is a different run.
        ...(references.length > 0
          ? {
              references: await Promise.all(
                references.map(async (reference, index) => ({
                  fileName: referenceFiles[index]!.name,
                  contentType: reference.mimeType,
                  contentSha256: await sha256Hex(reference.bytes),
                })),
              ),
            }
          : {}),
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    // The admin can change the model and price. Persist the reserved price on
    // the job so later setting changes do not alter this operation or its refund.
    const cost = selectedModel.priceUnits;
    const reservation = await createReservedAiJob({
      userId,
      kind: "image",
      provider: "openrouter",
      status: "running",
      inputParams: {
        prompt,
        aspectRatio,
        ...(background && background !== "auto" ? { background } : {}),
        ...(seed === undefined ? {} : { seed }),
        ...(referenceFiles.length > 0
          ? { references: referenceFiles.map((file) => ({ filename: file.name })) }
          : {}),
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      ...requestIdentity,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      const existingJob = reservation.job;
      if (existingJob.status === "succeeded" && existingJob.resultFileId) {
        return c.json({
          jobId: existingJob.id,
          fileId: existingJob.resultFileId,
          url: await getContentUrl(existingJob.resultFileId, c.req.raw),
          ...(existingJob.resultFile
            ? {
              fileName: existingJob.resultFile.name,
              contentType: existingJob.resultFile.mimeType,
            }
            : {}),
        });
      }
      if (existingJob.status === "queued" ||
        existingJob.status === "running" ||
        existingJob.status === "finalizing") {
        return c.json(await apiErrorResponse("aiRequestInProgress"), {
          status: 409,
        });
      }
      return c.json(await apiErrorResponse("aiProviderError"), { status: 500 });
    }

    try {
      const result = await generateImage({
        prompt,
        aspectRatio,
        ...(background ? { background } : {}),
        ...(references.length > 0
          ? {
              referenceImages: references.map((reference) => ({
                bytes: reference.bytes,
                mimeType: reference.mimeType,
              })),
            }
          : {}),
        ...(seed === undefined ? {} : { seed }),
        model: selectedModel.modelId,
        signal: c.req.raw.signal,
      });
      const { bytes, mimeType } = await decodeImageResult(result);
      const file = await saveAiImage({
        jobId: job.id,
        userId,
        bytes,
        mimeType,
        filename: `ai-image-${job.id}.png`,
      });
      return c.json({
        jobId: job.id,
        fileId: file.id,
        url: await getContentUrl(file.id, c.req.raw),
        fileName: file.name,
        contentType: file.mimeType,
      });
    } catch (err) {
      // Synchronous provider calls have no durable handle that can recover an
      // ambiguous result. Customer usage is therefore refunded on every
      // unsuccessful response, even if the provider may have accepted work.
      await failAiJobAndRefundUsage({
        userId,
        aiJobId: job.id,
        error: AI_JOB_FAILURE_MESSAGES.imageGeneration,
      });
      if (err instanceof AiProviderError) {
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      throw err;
    }
  })
  .post("/edit", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const entitlements = await getEntitlements(userId);
    if (!entitlements.canUseAi) {
      return c.json(await apiErrorResponse("aiPlanRequired"), {
        status: 402,
      });
    }
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await parseBodyWithUploadLimit(
        c.req,
        MAX_AI_IMAGE_UPLOAD_BYTES,
      );
    } catch (error) {
      if (isUploadLimitExceeded(error)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
      throw error;
    }
    const file = body["file"];
    if (
      file instanceof File &&
      fileExceedsUploadLimit(file, MAX_AI_IMAGE_UPLOAD_BYTES)
    ) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), {
        status: 413,
      });
    }
    const fields = editFieldsSchema.safeParse({
      task: body["task"],
      ...(body["prompt"] !== undefined
        ? { prompt: body["prompt"] }
        : {}),
      ...(body["model"] !== undefined ? { model: body["model"] } : {}),
    });
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      !fields.success
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const editTask = fields.data.task;
    const userPrompt = fields.data.prompt || undefined;
    const requiresPrompt = aiImageEditTaskRequiresPrompt(editTask);
    if (requiresPrompt && !userPrompt) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const editPrompt = requiresPrompt ? userPrompt : undefined;
    const inputImage = await validateAiInputImage(
      file,
      supportedInputImageTypes,
    );
    if (!inputImage) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve(
      `image.edit.${editTask}`,
      fields.data.model,
    );
    if (!selectedModel) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    // An edit hands the model a picture, cutting out a background or asking for
    // a size; a model that takes none of those is refused before it is paid for.
    if (
      unsupportedImageRequestReason(
        (await loadAiImageModelCapabilities([selectedModel.modelId])).get(
          selectedModel.modelId,
        ),
        {
          // The picture being edited.
          referenceImages: 1,
          // Removing a background is asking for a transparent one.
          ...(editTask === "remove_background"
            ? { background: "transparent" as const }
            : {}),
          resolution: editTask === "upscale",
        },
      )
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }

    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: `image.edit.${editTask}`,
      input: {
        task: editTask,
        model: selectedModel.modelId,
        ...(editPrompt ? { prompt: editPrompt } : {}),
        fileName: file.name,
        contentType: inputImage.mimeType,
        contentSha256: await sha256Hex(inputImage.bytes),
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const cost = selectedModel.priceUnits;
    const reservation = await createReservedAiJob({
      userId,
      kind: "image_edit",
      provider: "openrouter",
      status: "running",
      inputParams: {
        task: editTask,
        filename: file.name,
        ...(editPrompt ? { prompt: editPrompt } : {}),
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      ...requestIdentity,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      const existingJob = reservation.job;
      if (existingJob.status === "succeeded" && existingJob.resultFileId) {
        return c.json({
          jobId: existingJob.id,
          fileId: existingJob.resultFileId,
          url: await getContentUrl(existingJob.resultFileId, c.req.raw),
          ...(existingJob.resultFile
            ? {
              fileName: existingJob.resultFile.name,
              contentType: existingJob.resultFile.mimeType,
            }
            : {}),
        });
      }
      if (existingJob.status === "queued" ||
        existingJob.status === "running" ||
        existingJob.status === "finalizing") {
        return c.json(await apiErrorResponse("aiRequestInProgress"), {
          status: 409,
        });
      }
      return c.json(await apiErrorResponse("aiProviderError"), { status: 500 });
    }

    try {
      const result = await editImage({
        task: editTask,
        image: inputImage.bytes,
        mimeType: inputImage.mimeType,
        ...(editPrompt ? { prompt: editPrompt } : {}),
        model: selectedModel.modelId,
        signal: c.req.raw.signal,
      });
      const { bytes, mimeType: outputMimeType } =
        await decodeImageResult(result);
      const saved = await saveAiImage({
        jobId: job.id,
        userId,
        bytes,
        mimeType: outputMimeType,
        filename: `ai-edit-${job.id}.png`,
      });
      return c.json({
        jobId: job.id,
        fileId: saved.id,
        url: await getContentUrl(saved.id, c.req.raw),
        fileName: saved.name,
        contentType: saved.mimeType,
      });
    } catch (err) {
      await failAiJobAndRefundUsage({
        userId,
        aiJobId: job.id,
        error: AI_JOB_FAILURE_MESSAGES.imageEdit,
      });
      if (err instanceof AiProviderError) {
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      throw err;
    }
  });

export default app;
