import type { VideoModel } from "@openrouter/sdk/models";
import type { AiVideoAspectRatio, AiVideoResolution } from "@beutl/core";
import {
  AiProviderError,
  AiVideoSubmissionError,
  createOpenRouterClient,
  createPublicOpenRouterClient,
  openRouterExecutionOf,
  openRouterRequestOptions,
  toAiProviderError,
  type VideoFrameImage,
  type VideoGenerationStatus,
  type VideoJobInfo,
} from "./openrouter";

// The video endpoints go through OpenRouter's own SDK, like every other call
// this service makes. What a video request may contain differs per model —
// resolutions, durations, aspect ratios, audio, seed — and the SDK is where
// that shape is kept current, along with the per-model capability list this
// service reads to decide what to offer.
//
// Downloading the finished video stays on the hand-rolled request: it needs the
// declared content type to cross-check the bytes, and the SDK hands back only a
// body stream.

const CAPABILITY_TIMEOUT_MS = 5_000;
const MAX_CAPABILITY_RESPONSE_BYTES = 4 * 1024 * 1024;

const VIDEO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

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

  let client: ReturnType<typeof createOpenRouterClient>;
  let requestOptions: { signal?: AbortSignal };
  try {
    client = createOpenRouterClient();
    requestOptions = openRouterRequestOptions(signal);
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
      requestOptions,
    );
    return toVideoJobInfo(response);
  } catch (cause) {
    if (cause instanceof AiProviderError) throw cause;
    const error = toAiProviderError(cause, "OpenRouter video submission failed");
    throw new AiVideoSubmissionError(error.message, {
      outcome: openRouterExecutionOf(cause),
      cause,
      ...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus }),
    });
  }
}

export async function getVideoJob(id: string): Promise<VideoJobInfo> {
  const client = createOpenRouterClient();
  try {
    const response = await client.videoGeneration.getGeneration({ jobId: id });
    return toVideoJobInfo(response);
  } catch (cause) {
    throw toAiProviderError(cause, "OpenRouter video poll failed");
  }
}

// Every video model OpenRouter offers, with the capabilities it publishes.
// Callers are expected to cache this; it is one request for the whole list.
//
// Unauthenticated, because the endpoint is public and the admin console reads
// it too — that worker holds no provider credentials, and asking for a key here
// would leave it unable to tell an administrator that a model it registered
// cannot serve anything. Short-timed for the same reason a price lookup is: a
// page must not hang on the provider.
export async function listVideoModels(): Promise<VideoModel[]> {
  const client = createPublicOpenRouterClient({
    timeoutMs: CAPABILITY_TIMEOUT_MS,
    maximumResponseBytes: MAX_CAPABILITY_RESPONSE_BYTES,
  });
  try {
    const response = await client.videoGeneration.listVideosModels();
    return response.data;
  } catch (cause) {
    throw toAiProviderError(cause, "OpenRouter video model list failed");
  }
}
