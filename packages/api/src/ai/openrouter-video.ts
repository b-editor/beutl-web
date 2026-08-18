import { OpenRouter } from "@openrouter/sdk";
import {
  ConnectionError,
  InvalidRequestError,
  OpenRouterError,
  RequestAbortedError,
  RequestTimeoutError,
} from "@openrouter/sdk/models/errors";
import type { VideoModel } from "@openrouter/sdk/models";
import type { AiVideoAspectRatio, AiVideoResolution } from "@beutl/core";
import {
  AiProviderError,
  AiVideoSubmissionError,
  getOpenRouterApiKey,
  getOpenRouterRequestTimeoutMilliseconds,
  type AiVideoSubmissionOutcome,
  type VideoFrameImage,
  type VideoGenerationStatus,
  type VideoJobInfo,
} from "./openrouter";

// The video endpoints go through OpenRouter's own SDK rather than hand-built
// requests. What a video request may contain differs per model — resolutions,
// durations, aspect ratios, audio, seed — and the SDK is where that shape is
// kept current, along with the per-model capability list this service reads to
// decide what to offer.
//
// Downloading the finished video stays on the hand-rolled request: it needs the
// declared content type to cross-check the bytes, and the SDK hands back only a
// body stream.

// A submission is not idempotent — every accepted request is a video the user
// is charged for. The SDK retries 5XX and connection errors for up to an hour
// by default, which would resubmit a request whose response was merely lost.
const NO_RETRIES = { strategy: "none" } as const;

const VIDEO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export function createOpenRouterClient(): OpenRouter {
  return new OpenRouter({
    apiKey: getOpenRouterApiKey(),
    timeoutMs: getOpenRouterRequestTimeoutMilliseconds(),
    retryConfig: NO_RETRIES,
  });
}

// The SDK applies its own timeout only when the caller passes no signal, so a
// caller-supplied one is combined with the timeout rather than replacing it.
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  return signal
    ? { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) }
    : {};
}

// Whether the provider certainly did not take the job on, which is what decides
// between refunding the reservation and leaving it queued for a callback.
//
// Only a client-side rejection or a 4XX proves nothing was started. A dropped
// connection does not: the request may have arrived and the response been lost,
// and refunding that leaks a video the user paid for.
function submissionOutcomeOf(error: unknown): AiVideoSubmissionOutcome {
  if (error instanceof InvalidRequestError) return "definite_failure";
  if (error instanceof OpenRouterError) {
    return error.statusCode >= 400 && error.statusCode < 500
      ? "definite_failure"
      : "unknown";
  }
  return "unknown";
}

// The provider's own words about the failure. The user is shown a generic
// message, so without this the reason a model rejected a request — an
// unsupported resolution, a duration it does not offer — is lost entirely.
function providerFailureMessage(error: unknown): string {
  if (error instanceof OpenRouterError) {
    return `OpenRouter video request failed: ${error.statusCode} ${error.body.slice(0, 1_000)}`;
  }
  if (error instanceof RequestTimeoutError) {
    return "OpenRouter video request timed out";
  }
  if (error instanceof RequestAbortedError) {
    return "OpenRouter video request was cancelled before its outcome was known";
  }
  if (error instanceof ConnectionError) {
    return "OpenRouter video request could not be completed";
  }
  return error instanceof Error
    ? error.message
    : "OpenRouter video request failed";
}

function isVideoStatus(value: string): value is VideoGenerationStatus {
  return (VIDEO_STATUSES as readonly string[]).includes(value);
}

function toVideoJobInfo(response: {
  id: string;
  status: string;
  unsignedUrls?: string[] | undefined;
  error?: string | undefined;
}): VideoJobInfo {
  if (!response.id || !isVideoStatus(response.status)) {
    throw new AiProviderError("OpenRouter returned invalid video job data", {
      execution: "unknown",
    });
  }
  return {
    id: response.id,
    status: response.status,
    unsignedUrls: response.unsignedUrls,
    error: response.error || null,
  };
}

export async function createVideoJob({
  prompt,
  durationSeconds,
  resolution,
  aspectRatio,
  generateAudio,
  seed,
  frameImages,
  callbackUrl,
  model,
  signal,
}: {
  prompt: string;
  durationSeconds: number;
  resolution: AiVideoResolution;
  aspectRatio?: AiVideoAspectRatio;
  generateAudio?: boolean;
  seed?: number;
  frameImages?: VideoFrameImage[];
  // Omitted when the deployment has no HTTPS origin to be called back on, in
  // which case the job is finished by polling instead.
  callbackUrl?: string;
  model: string;
  signal?: AbortSignal;
}): Promise<VideoJobInfo> {
  if (callbackUrl !== undefined) {
    let parsedCallbackUrl: URL;
    try {
      parsedCallbackUrl = new URL(callbackUrl);
    } catch (cause) {
      throw new AiVideoSubmissionError(
        "OpenRouter video callback URL is invalid",
        { outcome: "definite_failure", cause },
      );
    }
    if (parsedCallbackUrl.protocol !== "https:") {
      throw new AiVideoSubmissionError(
        "OpenRouter video callback URL must use HTTPS",
        { outcome: "definite_failure" },
      );
    }
  }

  let client: OpenRouter;
  let timeoutMs: number;
  try {
    timeoutMs = getOpenRouterRequestTimeoutMilliseconds();
    client = createOpenRouterClient();
  } catch (cause) {
    // Nothing was sent, so the reservation is safe to refund.
    throw new AiVideoSubmissionError(
      cause instanceof Error ? cause.message : "OpenRouter is not configured",
      { outcome: "definite_failure", cause },
    );
  }

  try {
    const response = await client.videoGeneration.generate(
      {
        videoGenerationRequest: {
          model,
          prompt,
          duration: durationSeconds,
          resolution,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(generateAudio === undefined ? {} : { generateAudio }),
          ...(seed === undefined ? {} : { seed }),
          ...(callbackUrl === undefined ? {} : { callbackUrl }),
          ...(frameImages && frameImages.length > 0
            ? {
                frameImages: frameImages.map((frame) => ({
                  type: frame.type,
                  imageUrl: { url: frame.image_url.url },
                  frameType: frame.frame_type,
                })),
              }
            : {}),
        },
      },
      { retries: NO_RETRIES, ...requestSignal(signal, timeoutMs) },
    );
    return toVideoJobInfo(response);
  } catch (cause) {
    if (cause instanceof AiProviderError) throw cause;
    throw new AiVideoSubmissionError(providerFailureMessage(cause), {
      outcome: submissionOutcomeOf(cause),
      cause,
      ...(cause instanceof OpenRouterError
        ? { httpStatus: cause.statusCode }
        : {}),
    });
  }
}

export async function getVideoJob(id: string): Promise<VideoJobInfo> {
  const client = createOpenRouterClient();
  try {
    const response = await client.videoGeneration.getGeneration({ jobId: id });
    return toVideoJobInfo(response);
  } catch (cause) {
    if (cause instanceof AiProviderError) throw cause;
    throw new AiProviderError(providerFailureMessage(cause), {
      cause,
      execution: submissionOutcomeOf(cause),
      ...(cause instanceof OpenRouterError
        ? { httpStatus: cause.statusCode }
        : {}),
    });
  }
}

// Every video model OpenRouter offers, with the capabilities it publishes.
// Callers are expected to cache this; it is one request for the whole list.
export async function listVideoModels(): Promise<VideoModel[]> {
  const client = createOpenRouterClient();
  try {
    const response = await client.videoGeneration.listVideosModels();
    return response.data;
  } catch (cause) {
    if (cause instanceof AiProviderError) throw cause;
    throw new AiProviderError(providerFailureMessage(cause), {
      cause,
      execution: "definite_failure",
      ...(cause instanceof OpenRouterError
        ? { httpStatus: cause.statusCode }
        : {}),
    });
  }
}
