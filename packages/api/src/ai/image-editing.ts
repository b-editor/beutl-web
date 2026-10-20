import { createReservedAiJob, failAiJobAndRefundUsage } from "./credits";
import { imageCapabilityOf, loadAiImageModelCapabilities, unsupportedImageRequestReason } from "./image-model-capabilities";
import { decodeGeneratedImageBase64, inspectGeneratedImage, InvalidGeneratedImageError } from "./image-validation";
import { inspectGeneratedJpeg } from "./input-image-validation";
import { AI_JOB_FAILURE_MESSAGES, aiJobFailureMessage, reportAiProviderFailure } from "./job-errors";
import type { AiModelCatalog } from "./model-catalog";
import { AiProviderError } from "./providers/errors";
import { imageProviderFor, providerRequiresPreparedOutpaintCanvas } from "./providers/registry";
import type { AiImageEditRequest } from "./providers/types";
import type { AiRequestIdentity } from "./request-integrity";
import { saveAiImage } from "./storage";

export async function prepareImageEdit({ userId, model, identity, input, allowJpeg = false }: {
  userId: string;
  model: ReturnType<AiModelCatalog["resolve"]>;
  identity: AiRequestIdentity;
  input: Omit<AiImageEditRequest, "model" | "signal"> & {
    filename: string;
    /** Present only when the caller supplies an expanded outpaint canvas. */
    outpaintExpansion?: number;
  };
  /** Preserve each entry point's existing output format contract. */
  allowJpeg?: boolean;
}) {
  if (!model) {
    return { ok: false as const, errorCode: "aiModelUnavailable" as const, status: 400 as const };
  }
  const { task, image, mimeType, prompt, filename, outpaintExpansion } = input;
  const operation = `image.edit.${task}`;
  if ((providerRequiresPreparedOutpaintCanvas(model.provider, operation) && outpaintExpansion === undefined) ||
    unsupportedImageRequestReason(
      imageCapabilityOf(await loadAiImageModelCapabilities([model]), model),
      { referenceImages: 1, ...(task === "remove_background" ? { background: "transparent" as const } : {}), resolution: task === "upscale" },
    )) {
    return { ok: false as const, errorCode: "aiModelDoesNotSupportRequest" as const, status: 400 as const };
  }
  const reservation = await createReservedAiJob({
    userId, kind: "image_edit", provider: model.provider, status: "running",
    inputParams: {
      task, filename, ...(prompt ? { prompt } : {}),
      ...(outpaintExpansion === undefined ? {} : { outpaintExpansion }),
    },
    usagePercent: model.usagePercent, imageOutputTokenProfile: model.imageOutputTokenProfile,
    model: model.modelId, ...identity,
  });
  if (!reservation.ok || reservation.outcome === "existing") return reservation;
  const { job } = reservation;
  return {
    ...reservation,
    async execute(options: Pick<AiImageEditRequest, "signal"> = {}) {
      try {
        const result = await imageProviderFor(model.provider).edit({
          task, image, mimeType, ...(prompt ? { prompt } : {}), model: model.modelId, ...options,
        });
        const bytes = decodeGeneratedImageBase64(result.b64Json);
        const metadata = allowJpeg && task !== "remove_background" && result.mediaType === "image/jpeg"
          ? inspectGeneratedJpeg(bytes)
          : await inspectGeneratedImage(bytes, result.mediaType);
        const file = await saveAiImage({
          jobId: job.id, userId, bytes, mimeType: metadata.mimeType,
          filename: `ai-edit-${job.id}.${metadata.mimeType === "image/jpeg" ? "jpg" : "png"}`,
          providerCostUsd: result.providerCostUsd,
        });
        return { ok: true as const, file };
      } catch (error) {
        await failAiJobAndRefundUsage({
          userId, aiJobId: job.id,
          error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.imageEdit),
        });
        const providerError = error instanceof InvalidGeneratedImageError
          ? new AiProviderError("AI provider returned invalid image bytes", { cause: error })
          : error;
        if (providerError instanceof AiProviderError) {
          reportAiProviderFailure({ operation, jobId: job.id, provider: model.provider, model: model.modelId, error: providerError });
        }
        return { ok: false as const, error };
      }
    },
  };
}
