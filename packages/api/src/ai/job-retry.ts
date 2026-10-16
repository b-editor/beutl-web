// Reruns a finished image or video job on the model and provider it ran on.
// POST /v3/ai/jobs/:id/retry and the dashboard's retryJobAction share it.
import { getAiJobByIdempotency, getAiJobByUserId } from "@beutl/db";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_RESOLUTIONS,
  aspectRatioOfLegacyImageSize,
  isAiSeed,
  isAiVideoDurationSeconds,
  type AiImageAspectRatio,
  type AiImageBackground,
  type AiVideoAspectRatio,
  type AiVideoResolution,
  type ApiErrorCode,
} from "@beutl/core";
import { createReservedAiJob, failAiJobAndRefundUsage } from "./credits";
import {
  imageCapabilityOf,
  loadAiImageModelCapabilities,
  unsupportedImageRequestReason,
} from "./image-model-capabilities";
import { decodeGeneratedImageBase64, inspectGeneratedImage } from "./image-validation";
import {
  AI_JOB_FAILURE_MESSAGES,
  aiJobFailureMessage,
  reportAiProviderFailure,
} from "./job-errors";
import { parseReplayableAiJobInput } from "./job-inputs";
import { loadAiModelCatalog, type AiModelCatalog } from "./model-catalog";
import { AiProviderError, aiProviderFailureCode } from "./providers/errors";
import { DEFAULT_AI_PROVIDER_ID, imageProviderFor } from "./providers/registry";
import type { PartialImage } from "./providers/types";
import {
  createCallbackNonce,
  hashAiIdempotencyKey,
  toAiRequestIdentity,
} from "./request-integrity";
import { saveAiImage } from "./storage";
import {
  loadAiVideoModelCapabilities,
  unsupportedVideoRequestReason,
  videoCapabilityOf,
} from "./video-model-capabilities";
import { classifyVideoSubmissionFailure, createAndAttachVideoJob } from "./video-jobs";

type AiJobRetryRefusal = {
  ok: false;
  errorCode: ApiErrorCode;
  status: 400 | 402 | 403 | 404 | 409 | 429 | 503;
};

type AiProviderFailure = {
  ok: false;
  errorCode: ReturnType<typeof aiProviderFailureCode>;
  status: 500;
};

type Reservation = Awaited<ReturnType<typeof createReservedAiJob>>;
type ExistingAiJob = Extract<Reservation, { outcome: "existing" }>["job"];
type ReservedAiJob = Extract<Reservation, { outcome: "reserved" }>["job"];

type CatalogEntry = NonNullable<ReturnType<AiModelCatalog["resolve"]>>;

type AiImageRetryResult =
  | { ok: true; jobId: string; file: { id: string; name: string; mimeType: string } }
  | AiProviderFailure;

/** `submitted: false` means the provider may have taken the job, so it stays queued. */
type AiVideoRetryResult =
  | { ok: true; job: ReservedAiJob; submitted: boolean }
  | AiProviderFailure;

/** How a provider reaches this deployment; each caller derives it from its own request. */
export type AiVideoRetryTarget = {
  mediaOrigin(): string | undefined | Promise<string | undefined>;
  callbackUrl(jobId: string, nonce: string, provider: string): string | undefined | Promise<string | undefined>;
  signal?: AbortSignal;
};

export type AiJobRetry =
  | AiJobRetryRefusal
  | { ok: true; kind: "image"; outcome: "existing"; job: ExistingAiJob }
  | { ok: true; kind: "video"; outcome: "existing"; job: ExistingAiJob }
  | {
    ok: true;
    kind: "image";
    outcome: "reserved";
    job: ReservedAiJob;
    generate(options?: {
      signal?: AbortSignal;
      onPartialImage?: (partial: PartialImage) => void;
    }): Promise<AiImageRetryResult>;
  }
  | {
    ok: true;
    kind: "video";
    outcome: "reserved";
    job: ReservedAiJob;
    submit(target: AiVideoRetryTarget): Promise<AiVideoRetryResult>;
  };

function refuse(
  errorCode: ApiErrorCode,
  status: AiJobRetryRefusal["status"],
): AiJobRetryRefusal {
  return { ok: false, errorCode, status };
}

/**
 * The catalog entry a rerun must use: the same model on the same provider the
 * paid original ran on.
 *
 * Resolving by model id alone takes whichever provider that id currently
 * carries. An administrator who moves an id from OpenRouter to the Gateway
 * would otherwise have a rerun validated against, and dispatched to, a
 * different service than the one the user already paid — for the same job.
 * Nothing left to re-run on the original pair is "unavailable", which is what
 * the caller reports.
 */
function retryEntryFor(
  catalog: AiModelCatalog,
  operation: string,
  job: { model: string | null; provider?: string | null },
) {
  const entry = catalog.resolve(operation, job.model ?? undefined);
  if (!entry) return null;
  // A row written before the column existed carries the one provider there
  // was, which is the same resolution the catalog itself makes.
  const ranOn = job.provider ?? DEFAULT_AI_PROVIDER_ID;
  return entry.provider === ranOn ? entry : null;
}

type ReplayInput = { prompt: string; [key: string]: unknown };

type ImageRetryRequest = {
  prompt: string;
  aspectRatio: AiImageAspectRatio;
  background?: AiImageBackground;
  seed?: number;
};

type VideoRetryRequest = {
  prompt: string;
  durationSeconds: number;
  resolution: AiVideoResolution;
  aspectRatio: AiVideoAspectRatio;
  generateAudio: boolean;
  seed?: number;
};

// Everything that can refuse a rerun runs here, up to its reservation; the caller runs the job.
export async function prepareAiJobRetry({
  userId,
  jobId,
  idempotencyKey,
  confirm,
}: {
  userId: string;
  jobId: string;
  idempotencyKey: unknown;
  // The dashboard pins the job its dialog showed; a row changed since is refused.
  confirm?: (job: {
    kind: string;
    model: string | null;
    inputParams: Record<string, unknown>;
  }) => Promise<boolean>;
}): Promise<AiJobRetry> {
  const idempotencyKeyHash = await hashAiIdempotencyKey(idempotencyKey);
  if (!idempotencyKeyHash) return refuse("invalidRequestBody", 400);
  const [existing, job] = await Promise.all([
    getAiJobByIdempotency({ userId, idempotencyKeyHash }),
    getAiJobByUserId({ userId, jobId }),
  ]);
  // A paid retry answers under its key even after its source job or model settings changed.
  if (existing) return await replayedRetry({ existing, source: job, idempotencyKey });
  if (!job) return refuse("aiJobNotFound", 404);
  if (job.status !== "failed" && job.status !== "succeeded") {
    return refuse("aiJobIsActive", 409);
  }
  const replayInput = parseReplayableAiJobInput(job.kind, job.inputParams);
  if (!replayInput.success) return refuse("invalidRequestBody", 400);
  const input = replayInput.data;
  if (
    confirm &&
    !(await confirm({ kind: job.kind, model: job.model, inputParams: input }))
  ) {
    return refuse("aiRequestChanged", 409);
  }
  // A rerun repeats the request, so it repeats the model too. If that model has
  // since been disabled the retry is refused rather than moved to the default:
  // silently running something else and charging the default's price is not a
  // retry. Jobs from before the column existed carry no model and resolve to
  // the operation's default, which is what they ran on.
  const catalog = await loadAiModelCatalog();
  if (job.kind === "image") {
    const request = imageRetryRequest(input);
    if (!request) return refuse("invalidRequestBody", 400);
    return await prepareImageRetry({ userId, job, request, catalog, idempotencyKey });
  }
  if (job.kind === "video") {
    const request = videoRetryRequest(input);
    if (!request) return refuse("invalidRequestBody", 400);
    return await prepareVideoRetry({ userId, job, request, catalog, idempotencyKey });
  }
  return refuse("invalidRequestBody", 400);
}

async function replayedRetry({
  existing,
  source,
  idempotencyKey,
}: {
  existing: ExistingAiJob;
  source: { kind: string; model: string | null; inputParams: unknown } | null;
  idempotencyKey: unknown;
}): Promise<AiJobRetry> {
  if (existing.kind !== "image" && existing.kind !== "video") {
    return refuse("aiRequestChanged", 409);
  }
  // Without the source job (deleted) the key is all there is to go by.
  if (source) {
    const replay = parseReplayableAiJobInput(source.kind, source.inputParams);
    const request = !replay.success
      ? null
      : source.kind === "image"
        ? imageRetryRequest(replay.data)
        : videoRetryRequest(replay.data);
    // A legacy source carries no model; the first retry recorded the default it used.
    const identity = request &&
      await retryIdentity(idempotencyKey, source.kind, source.model ?? existing.model, request);
    if (identity?.requestFingerprint !== existing.requestFingerprint) {
      return refuse("aiRequestChanged", 409);
    }
  }
  if (existing.deletedAt) return refuse("aiRequestWasDeleted", 409);
  return existing.kind === "image"
    ? { ok: true, kind: "image", outcome: "existing", job: existing }
    : { ok: true, kind: "video", outcome: "existing", job: existing };
}

async function retryIdentity(
  idempotencyKey: unknown,
  kind: string,
  model: string | null,
  request: ImageRetryRequest | VideoRetryRequest,
) {
  return await toAiRequestIdentity({
    idempotencyKey,
    operation: kind === "image" ? "image.generate" : "video.generate",
    input: { model, ...request },
  });
}

// Null when the persisted input cannot be repeated exactly.
function imageRetryRequest(input: ReplayInput): ImageRetryRequest | null {
  // The reference image was never stored, so this would generate something
  // else and charge for it.
  // Both spellings have existed in persisted jobs. Neither can be replayed
  // because the uploaded bytes were never retained; accepting either would
  // charge for a different, reference-free generation.
  if (input.reference !== undefined || input.references !== undefined) {
    return null;
  }
  // Required rather than defaulted: a generation always recorded its shape, so
  // a job without one is not a generation and must not be rerun as one. Jobs
  // predating aspect ratios carry the fixed size they were asked for.
  const aspectRatio =
    input.aspectRatio !== undefined
      ? typeof input.aspectRatio === "string"
        ? (input.aspectRatio as AiImageAspectRatio)
        : null
      : typeof input.size === "string"
        ? aspectRatioOfLegacyImageSize(input.size)
        : null;
  if (aspectRatio === null || !AI_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    return null;
  }
  // A missing background is the legacy "auto" request. A value that was
  // persisted but is no longer recognized cannot be silently changed to
  // auto: that would charge for a different request body.
  let background: AiImageBackground | undefined;
  if (input.background !== undefined) {
    if (
      typeof input.background !== "string" ||
      !AI_IMAGE_BACKGROUNDS.includes(input.background as AiImageBackground)
    ) {
      return null;
    }
    background =
      input.background === "auto"
        ? undefined
        : (input.background as AiImageBackground);
  }
  let seed: number | undefined;
  if (input.seed !== undefined) {
    if (!isAiSeed(input.seed)) return null;
    seed = input.seed;
  }
  return {
    prompt: input.prompt,
    aspectRatio,
    ...(background ? { background } : {}),
    ...(seed === undefined ? {} : { seed }),
  };
}

// Null when the persisted input cannot be repeated exactly.
function videoRetryRequest(input: ReplayInput): VideoRetryRequest | null {
  // The frames are not stored, so this would submit a different video and
  // charge for it. The button is hidden for these, but the rule belongs here.
  if (input.firstFrame !== undefined || input.lastFrame !== undefined) {
    return null;
  }
  // Jobs created before these existed carry none; the defaults reproduce what
  // they were actually submitted with.
  const durationSeconds = input.durationSeconds === undefined ? 4 : input.durationSeconds;
  const resolution = input.resolution === undefined ? "720p" : input.resolution;
  const aspectRatio = input.aspectRatio === undefined ? "16:9" : input.aspectRatio;
  const generateAudio = input.generateAudio === undefined ? true : input.generateAudio;
  let seed: number | undefined;
  if (input.seed !== undefined) {
    if (!isAiSeed(input.seed)) return null;
    seed = input.seed;
  }
  if (
    typeof durationSeconds !== "number" ||
    !isAiVideoDurationSeconds(durationSeconds) ||
    typeof resolution !== "string" ||
    !AI_VIDEO_RESOLUTIONS.includes(resolution as AiVideoResolution) ||
    typeof aspectRatio !== "string" ||
    !AI_VIDEO_ASPECT_RATIOS.includes(aspectRatio as AiVideoAspectRatio) ||
    typeof generateAudio !== "boolean"
  ) {
    return null;
  }
  return {
    prompt: input.prompt,
    durationSeconds,
    resolution: resolution as AiVideoResolution,
    aspectRatio: aspectRatio as AiVideoAspectRatio,
    generateAudio,
    ...(seed === undefined ? {} : { seed }),
  };
}

type RetrySource<Request> = {
  userId: string;
  job: { model: string | null; provider: string | null };
  request: Request;
  catalog: AiModelCatalog;
  idempotencyKey: unknown;
};

async function prepareImageRetry({
  userId,
  job,
  request,
  catalog,
  idempotencyKey,
}: RetrySource<ImageRetryRequest>): Promise<AiJobRetry> {
  const model = retryEntryFor(catalog, "image.generate", job);
  if (!model) return refuse("aiModelUnavailable", 400);
  // Capabilities may have narrowed since the original run. Validate the
  // exact replay before reserving usage so a now-unsupported ratio,
  // background, or seed never reaches the paid provider/refund path.
  if (
    unsupportedImageRequestReason(
      imageCapabilityOf(await loadAiImageModelCapabilities([model]), model),
      {
        aspectRatio: request.aspectRatio,
        background: request.background ?? "auto",
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        referenceImages: 0,
      },
    )
  ) {
    return refuse("aiModelDoesNotSupportRequest", 400);
  }
  const identity = await retryIdentity(idempotencyKey, "image", model.modelId, request);
  if (!identity) return refuse("invalidRequestBody", 400);
  const reservation = await createReservedAiJob({
    userId,
    kind: "image",
    provider: model.provider,
    status: "running",
    inputParams: request,
    usagePercent: model.usagePercent,
    imageOutputTokenProfile: model.imageOutputTokenProfile,
    model: model.modelId,
    ...identity,
  });
  if (!reservation.ok) return refuse(reservation.errorCode, reservation.status);
  // Two first attempts with one key arriving together; the reservation settles it.
  if (reservation.outcome === "existing") {
    return { ok: true, kind: "image", outcome: "existing", job: reservation.job };
  }
  const retried = reservation.job;
  return {
    ok: true,
    kind: "image",
    outcome: "reserved",
    job: retried,
    generate: async ({ signal, onPartialImage } = {}) => {
      try {
        const result = await imageProviderFor(model.provider).generate({
          ...request,
          imageSizeMode: model.imageSizeMode,
          model: model.modelId,
          ...(signal ? { signal } : {}),
          ...(onPartialImage ? { onPartialImage } : {}),
        });
        const bytes = decodeGeneratedImageBase64(result.b64Json);
        await inspectGeneratedImage(bytes, result.mediaType);
        const file = await saveAiImage({
          jobId: retried.id,
          userId,
          bytes,
          mimeType: "image/png",
          filename: `ai-image-${retried.id}.png`,
          providerCostUsd: result.providerCostUsd,
        });
        return {
          ok: true,
          jobId: retried.id,
          file: { id: file.id, name: file.name, mimeType: file.mimeType },
        };
      } catch (error) {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: retried.id,
          error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.imageGeneration),
        });
        if (error instanceof AiProviderError) {
          reportAiProviderFailure({
            operation: "image.generate", jobId: retried.id,
            provider: model.provider, model: model.modelId, error,
          });
        } else {
          console.error("Failed to retry an AI image", error);
        }
        return { ok: false, errorCode: aiProviderFailureCode(error), status: 500 };
      }
    },
  };
}

async function prepareVideoRetry({
  userId,
  job,
  request,
  catalog,
  idempotencyKey,
}: RetrySource<VideoRetryRequest>): Promise<AiJobRetry> {
  const model = retryEntryFor(catalog, "video.generate", job);
  if (!model) return refuse("aiModelUnavailable", 400);
  // What the model accepts can have changed since the original run, and a
  // rerun that the provider now refuses would be charged for first.
  if (
    unsupportedVideoRequestReason(
      videoCapabilityOf(await loadAiVideoModelCapabilities(), model),
      {
        resolution: request.resolution,
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        generateAudio: request.generateAudio,
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        promptCharacters: request.prompt.length,
      },
    )
  ) {
    return refuse("aiModelDoesNotSupportRequest", 400);
  }
  const identity = await retryIdentity(idempotencyKey, "video", model.modelId, request);
  if (!identity) return refuse("invalidRequestBody", 400);
  const callbackNonce = await createCallbackNonce();
  const reservation = await createReservedAiJob({
    userId,
    kind: "video",
    provider: model.provider,
    status: "queued",
    inputParams: request,
    usagePercent: model.usagePercent,
    model: model.modelId,
    callbackNonceHash: callbackNonce.hash,
    ...identity,
  });
  if (!reservation.ok) return refuse(reservation.errorCode, reservation.status);
  if (reservation.outcome === "existing") {
    return { ok: true, kind: "video", outcome: "existing", job: reservation.job };
  }
  const retried = reservation.job;
  return {
    ok: true,
    kind: "video",
    outcome: "reserved",
    job: retried,
    submit: (target) => submitVideoRetry({ userId, job: retried, model, request, callbackNonce, target }),
  };
}

async function submitVideoRetry({
  userId,
  job,
  model,
  request,
  callbackNonce,
  target,
}: {
  userId: string;
  job: ReservedAiJob;
  model: CatalogEntry;
  request: VideoRetryRequest;
  callbackNonce: { nonce: string; hash: string };
  target: AiVideoRetryTarget;
}): Promise<AiVideoRetryResult> {
  const { signal } = target;
  if (signal?.aborted) {
    // Nothing was sent yet, so the caller that went away is not charged.
    await failAiJobAndRefundUsage({
      userId,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
      expectedProviderJobId: null,
    });
    signal.throwIfAborted();
  }
  try {
    const mediaOrigin = await target.mediaOrigin();
    const callbackUrl = await target.callbackUrl(job.id, callbackNonce.nonce, model.provider);
    await createAndAttachVideoJob({
      jobId: job.id,
      ...request,
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
      callbackNonce: callbackNonce.nonce,
      callbackNonceHash: callbackNonce.hash,
      model: model.modelId,
      provider: model.provider,
      ...(mediaOrigin === undefined ? {} : { mediaOrigin }),
      ...(signal ? { signal } : {}),
    });
    return { ok: true, job, submitted: true };
  } catch (error) {
    // The provider may have accepted the job; the shared classifier decides whether to refund.
    const handling = classifyVideoSubmissionFailure(error);
    if (handling.action === "refund") {
      await failAiJobAndRefundUsage({
        userId,
        aiJobId: job.id,
        error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.videoSubmission),
        ...(handling.detachProviderJob ? { expectedProviderJobId: null } : {}),
      });
      return { ok: false, errorCode: aiProviderFailureCode(error), status: 500 };
    }
    if (handling.action === "keepQueued") {
      console.error(
        `${model.provider} video submission outcome is unknown for AI job ${job.id}`,
        error,
      );
      return { ok: true, job, submitted: false };
    }
    throw error;
  }
}
