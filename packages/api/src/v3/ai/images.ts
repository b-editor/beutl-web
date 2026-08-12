import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiSettings } from "../../ai/settings";
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
  type ImageGenerationSize,
} from "../../ai/openrouter";
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

const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]),
}).strict();

const editTasks = [
  "remove_background",
  "upscale",
  "restyle",
  "remove_object",
  "outpaint",
] as const;
type EditTask = (typeof editTasks)[number];
const promptRequiredEditTasks = new Set<EditTask>([
  "restyle",
  "remove_object",
  "outpaint",
]);

const editFieldsSchema = z.object({
  task: z.enum(editTasks),
  prompt: z.string().trim().max(MAX_AI_PROMPT_LENGTH).optional(),
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

    let rawBody: unknown;
    try {
      rawBody = await parseJsonWithBodyLimit<unknown>(c.req);
    } catch (error) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: isUploadLimitExceeded(error) ? 413 : 400,
      });
    }
    const parsedBody = generateSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const { prompt, size } = parsedBody.data;
    // 単価とモデルは管理画面から変更できる。予約時に確定した単価が AiJob に
    // 記録され、返金もその値を使うため、実行中に設定が変わっても影響しない。
    const settings = await loadAiSettings();
    const cost = settings.getPrice("image.generate");
    const reservation = await createReservedAiJob({
      userId,
      kind: "image",
      provider: "openrouter",
      status: "running",
      inputParams: { prompt, size },
      usageUnits: cost,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;

    try {
      const result = await generateImage({
        prompt,
        size: size as ImageGenerationSize,
        model: settings.getModel("image.generate"),
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
      });
    } catch (err) {
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
    const requiresPrompt = promptRequiredEditTasks.has(editTask);
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

    const settings = await loadAiSettings();
    const cost = settings.getPrice(`image.edit.${editTask}`);
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
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;

    try {
      const result = await editImage({
        task: editTask,
        image: inputImage.bytes,
        mimeType: inputImage.mimeType,
        ...(editPrompt ? { prompt: editPrompt } : {}),
        model: settings.getModel(`image.edit.${editTask}`),
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
