import { createReservedAiJob, failAiJobAndRefundUsage } from "./credits";
import {
  imageCapabilityOf,
  loadAiImageModelCapabilities,
  unsupportedImageRequestReason,
} from "./image-model-capabilities";
import {
  decodeGeneratedImageBase64,
  inspectGeneratedImage,
  InvalidGeneratedImageError,
} from "./image-validation";
import {
  AI_JOB_FAILURE_MESSAGES,
  aiJobFailureMessage,
  reportAiProviderFailure,
} from "./job-errors";
import type { AiModelCatalog } from "./model-catalog";
import { AiProviderError } from "./providers/errors";
import { imageProviderFor } from "./providers/registry";
import type { AiImageGenerateRequest, ImageReference } from "./providers/types";
import type { AiRequestIdentity } from "./request-integrity";
import { saveAiImage } from "./storage";

type ImageGenerationInput = Pick<
  AiImageGenerateRequest,
  "prompt" | "aspectRatio" | "background" | "seed"
> & { references?: (ImageReference & { filename: string })[] };

// Only a new reservation exposes execute(), so HTTP callers can reject before
// starting SSE. Execution retains the same model and input used for the quote.
export async function prepareImageGeneration({
  userId,
  model,
  identity,
  input,
}: {
  userId: string;
  model: ReturnType<AiModelCatalog["resolve"]>;
  identity: AiRequestIdentity;
  input: ImageGenerationInput;
}) {
  if (!model) {
    return { ok: false as const, errorCode: "aiModelUnavailable" as const, status: 400 as const };
  }
  const { prompt, aspectRatio, background, seed, references = [] } = input;
  if (unsupportedImageRequestReason(
    imageCapabilityOf(await loadAiImageModelCapabilities([model]), model),
    { aspectRatio, background, seed, referenceImages: references.length },
  )) {
    return { ok: false as const, errorCode: "aiModelDoesNotSupportRequest" as const, status: 400 as const };
  }

  const reservation = await createReservedAiJob({
    userId,
    kind: "image",
    provider: model.provider,
    status: "running",
    inputParams: {
      prompt,
      aspectRatio,
      ...(background && background !== "auto" ? { background } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(references.length > 0
        ? { references: references.map(({ filename }) => ({ filename })) }
        : {}),
    },
    usagePercent: model.usagePercent,
    imageOutputTokenProfile: model.imageOutputTokenProfile,
    model: model.modelId,
    ...identity,
  });
  if (!reservation.ok || reservation.outcome === "existing") return reservation;
  const { job } = reservation;

  return {
    ...reservation,
    async execute(options: Pick<AiImageGenerateRequest, "signal" | "onPartialImage"> = {}) {
      try {
        const result = await imageProviderFor(model.provider).generate({
          prompt,
          aspectRatio,
          imageSizeMode: model.imageSizeMode,
          ...(background ? { background } : {}),
          ...(seed === undefined ? {} : { seed }),
          ...(references.length > 0
            ? { referenceImages: references.map(({ bytes, mimeType }) => ({ bytes, mimeType })) }
            : {}),
          model: model.modelId,
          ...options,
        });
        const bytes = decodeGeneratedImageBase64(result.b64Json);
        const { mimeType } = await inspectGeneratedImage(bytes, result.mediaType);
        const file = await saveAiImage({
          jobId: job.id,
          userId,
          bytes,
          mimeType,
          filename: `ai-image-${job.id}.png`,
          providerCostUsd: result.providerCostUsd,
        });
        return { ok: true as const, file };
      } catch (error) {
        // Synchronous image calls have no durable provider handle. Even an
        // ambiguous failure must release the customer's reservation.
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.imageGeneration),
        });
        const providerError = error instanceof InvalidGeneratedImageError
          ? new AiProviderError("AI provider returned invalid image bytes", { cause: error })
          : error;
        if (providerError instanceof AiProviderError) {
          reportAiProviderFailure({
            operation: "image.generate", jobId: job.id,
            provider: model.provider, model: model.modelId, error: providerError,
          });
        }
        // A refund failure throws before this result; callers must not turn an
        // unresolved reservation into a terminal failure response.
        return { ok: false as const, error };
      }
    },
  };
}
