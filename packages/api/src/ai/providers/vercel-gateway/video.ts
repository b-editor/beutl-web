// Video generation through Vercel AI Gateway's asynchronous job API.
//
// `experimental_startVideo` and `experimental_getVideoStatus` line up with the
// two halves this service already had — submit, then poll — so the shape of
// the job handling does not change. Three things about the Gateway do:
//
//  1. A status request is addressed by model as well as by job id. The id
//     alone is enough for OpenRouter and never enough here.
//  2. The finished video comes back *with* the status, as a hosted URL or as
//     inline bytes. There is no second call that fetches it by id, which is
//     why `download` takes the job rather than its identifier.
//  3. Resolutions go out as pixel sizes even though the model list publishes
//     labels. See ./resolution.
//
// The SDK is used rather than the raw endpoints: it is the documented surface,
// it runs on workerd, and it sends the `idempotency-key` header that keeps a
// retried submission from billing a second generation. The wire protocol under
// it (`/v4/ai/video-model/start`) is versioned `0.0.1` and documented nowhere.

import {
  experimental_getVideoStatus as getVideoStatus,
  experimental_startVideo as startVideo,
} from "ai";
import { GatewayResponseError } from "@ai-sdk/gateway";
import {
  AiProviderError,
  AiVideoSubmissionError,
  InvalidAiProviderOutputError,
} from "../errors";
import {
  gatewayExecutionOf,
  gatewayResponseErrorType,
  toGatewayProviderError,
} from "./errors";
import { readBoundedBytes as readBoundedGatewayBytes } from "./bounded";
import type {
  AiVideoContent,
  AiVideoJobInfo,
  AiVideoJobRef,
  AiVideoStartRequest,
} from "../types";
import {
  inspectGeneratedVideo,
  InvalidGeneratedVideoError,
  MAX_AI_GENERATED_VIDEO_BYTES,
} from "../../video-validation";
import {
  createGatewayClient,
  gatewayRequestSignal,
} from "./config";
import { gatewayVideoResolution } from "./resolution";
import { gatewayProviderCostUsd, providerCostUsd, type ProviderCostUsd } from "../../provider-cost";

const GENERATION_COST_LOOKUP_TIMEOUT_MS = 5_000;

function gatewayProviderNamespace(creator: string): string {
  // The public catalog renamed xAI to SpaceXAI, while native options and
  // generation-ledger rows still use the former namespace.
  return creator === "spacexai" ? "xai" : creator;
}

function sameGatewayVideoModel(requested: string, billed: string): boolean {
  const canonical = (model: string) => {
    const separator = model.indexOf("/");
    return separator < 1
      ? model
      : gatewayProviderNamespace(model.slice(0, separator)) + model.slice(separator);
  };
  // The generation id must also match at the call site. Never accept a cost
  // merely because two different creators published the same model suffix.
  return canonical(requested) === canonical(billed);
}

function generationCostFromSchemaError(
  error: GatewayResponseError,
  generationId: string,
  model: string,
): ProviderCostUsd | undefined {
  // The SDK retains the parsed response after its strict text-metrics schema
  // rejects a valid video result. Read only the verified identity and cost;
  // the response may contain signed URLs or other provider data.
  if (error.statusCode !== 200 || typeof error.response !== "object" || error.response === null) {
    return undefined;
  }
  const data = (error.response as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return undefined;
  const entry = data as Record<string, unknown>;
  if (entry.id !== generationId ||
    typeof entry.model !== "string" ||
    !sameGatewayVideoModel(model, entry.model)) return undefined;
  return providerCostUsd(entry.total_cost);
}

function generationIdOf(providerMetadata: unknown): string | null {
  if (typeof providerMetadata !== "object" || providerMetadata === null) return null;
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (typeof gateway !== "object" || gateway === null) return null;
  const generationId = (gateway as Record<string, unknown>).generationId;
  return typeof generationId === "string" && /^gen_[0-9A-Za-z]{20,32}$/u.test(generationId)
    ? generationId
    : null;
}

async function completedVideoCost(
  providerMetadata: unknown,
  model: string,
): Promise<ProviderCostUsd | undefined> {
  const inlineCost = gatewayProviderCostUsd(providerMetadata);
  if (inlineCost !== undefined) return inlineCost;
  const generationId = generationIdOf(providerMetadata);
  if (!generationId) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AiProviderError("Gateway generation cost lookup timed out")),
        GENERATION_COST_LOOKUP_TIMEOUT_MS,
      );
    });
    const details = await Promise.race([
      createGatewayClient().getGenerationInfo({ id: generationId }),
      deadline,
    ]);
    // A mismatched response must not bill this job at someone else's price.
    if (details.id !== generationId || !sameGatewayVideoModel(model, details.model)) {
      return undefined;
    }
    return providerCostUsd(details.totalCost);
  } catch (error) {
    if (GatewayResponseError.isInstance(error)) {
      // The generation ledger is populated asynchronously. A 404 just after
      // video completion means a later status poll should try again.
      if (error.statusCode === 404) return undefined;
      const cost = generationCostFromSchemaError(error, generationId, model);
      if (cost !== undefined) return cost;
      const response = error.response;
      const data = typeof response === "object" && response !== null
        ? (response as Record<string, unknown>).data
        : undefined;
      const value = typeof data === "object" && data !== null
        ? data as Record<string, unknown>
        : null;
      console.warn("Gateway video generation info fields did not match", {
        model,
        statusCode: error.statusCode ?? null,
        responseFields: typeof response === "object" && response !== null
          ? Object.keys(response).slice(0, 12)
          : [],
        dataFields: value ? Object.keys(value).slice(0, 16) : [],
        generationMatches: value?.id === generationId,
        modelMatches: typeof value?.model === "string" &&
          sameGatewayVideoModel(model, value.model),
        actualModel: typeof value?.model === "string" ? value.model.slice(0, 80) : null,
        costType: typeof value?.total_cost,
      });
    }
    console.warn("Gateway video actual-cost lookup failed", {
      model,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The job id the Gateway assigned, read off the start response.
 *
 * It is the only part of `providerMetadata` this service keeps: a status
 * request is rebuilt from `{ gatewayJobId }` and the model, which is the
 * documented way to check a job from another process.
 */
function gatewayJobIdOf(providerMetadata: unknown): string | null {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return null;
  }
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (typeof gateway !== "object" || gateway === null) return null;
  const asyncJob = (gateway as Record<string, unknown>).asyncJob;
  if (typeof asyncJob !== "object" || asyncJob === null) return null;
  const jobId = (asyncJob as Record<string, unknown>).jobId;
  return typeof jobId === "string" && jobId.length > 0 ? jobId : null;
}

function costOf(providerMetadata: unknown): { providerCostUsd?: ProviderCostUsd } {
  const cost = gatewayProviderCostUsd(providerMetadata);
  return cost === undefined ? {} : { providerCostUsd: cost };
}

// The three modes that work from a video are the one part of this provider
// that is not provider-agnostic: the SDK has no top-level field for a source
// video, and each model reads it from its own `providerOptions` block. Only
// reference-to-video has a shared field.
//
// The mapping lives here rather than in the request so the service's own API
// stays neutral: a caller asks for "extend this clip", and which key that
// becomes is this adapter's business.
//
// Grok is the trap. `videoUrl` alone means editing; extension is the same
// field plus `mode: "extend-video"`, and forgetting it silently produces an
// edit — a different video, charged the same.
function modeProviderOptions(
  request: AiVideoStartRequest,
): Parameters<typeof startVideo>[0]["providerOptions"] {
  if (request.mode === undefined) return undefined;
  if (!request.sourceVideoUrl) {
    throw new AiVideoSubmissionError(
      `A ${request.mode} request needs a source video`,
      { outcome: "definite_failure" },
    );
  }

  const creator = request.model.split("/")[0];
  // A model creator is not always its SDK provider-options namespace.
  const namespace = gatewayProviderNamespace(creator);
  if (request.mode === "motion") {
    return {
      [namespace]: {
        videoUrl: request.sourceVideoUrl,
        characterOrientation: request.motionOrientation ?? "video",
        // "std" and "pro" are the provider's words for it.
        mode: request.motionQuality === "pro" ? "pro" : "std",
      },
    };
  }
  return {
    [namespace]: {
      videoUrl: request.sourceVideoUrl,
      ...(request.mode === "extend" ? { mode: "extend-video" } : {}),
    },
  };
}

/** The finished videos, carried from the status response to `download`. */
type GatewayVideoResult = {
  videos: readonly {
    type: string;
    url?: string;
    data?: string | Uint8Array;
    mediaType?: string;
  }[];
};

export async function startGatewayVideoJob(
  request: AiVideoStartRequest,
): Promise<AiVideoJobInfo> {
  if (request.callbackUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(request.callbackUrl);
    } catch (cause) {
      throw new AiVideoSubmissionError(
        "Vercel AI Gateway video callback URL is invalid",
        { outcome: "definite_failure", cause },
      );
    }
    if (parsed.protocol !== "https:") {
      throw new AiVideoSubmissionError(
        "Vercel AI Gateway video callback URL must use HTTPS",
        { outcome: "definite_failure" },
      );
    }
  }
  if (request.signal?.aborted) {
    throw new AiVideoSubmissionError(
      "Vercel AI Gateway video submission was cancelled before it was sent",
      { outcome: "definite_failure", cause: request.signal.reason },
    );
  }

  // A shape this service offers that the model list spells differently. Sending
  // nothing is better than sending a size no model was documented to take: the
  // model then picks, and the request is still refused up front by the
  // capability check if the label itself was unsupported.
  const resolution = gatewayVideoResolution(
    request.resolution,
    request.aspectRatio,
  );

  const providerOptions = modeProviderOptions(request);
  // Motion control reads the character picture from the prompt rather than
  // from the frame list, so the one picture a motion request carries travels
  // with the words.
  const characterImage = request.mode === "motion"
    ? request.frameImages?.[0]?.image_url.url
    : undefined;

  let result: Awaited<ReturnType<typeof startVideo>>;
  try {
    result = await startVideo({
      model: createGatewayClient().videoModel(request.model),
      prompt: characterImage
        ? { image: characterImage, text: request.prompt }
        : request.prompt,
      duration: request.durationSeconds,
      ...(resolution === null ? {} : { resolution }),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.generateAudio === undefined
        ? {}
        : { generateAudio: request.generateAudio }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      // Both arrive as hosted URLs: the submission path uploads them because
      // this provider persists the request and caps what it will persist.
      ...(request.frameImages && request.frameImages.length > 0 && !characterImage
        ? {
            frameImages: request.frameImages.map((frame) => ({
              image: frame.image_url.url,
              frameType: frame.frame_type,
            })),
          }
        : {}),
      ...(providerOptions === undefined
        ? {}
        : { providerOptions }),
      // Frames win where both are given — the Gateway would ignore the
      // references and warn — so the entry point refuses the combination and
      // this never sends both.
      ...(request.inputReferences && request.inputReferences.length > 0
        ? {
            inputReferences: request.inputReferences.map((reference) => ({
              data: reference.image_url.url,
              mediaType: reference.media_type,
            })),
          }
        : {}),
      ...(request.callbackUrl === undefined
        ? {}
        : { webhookUrl: request.callbackUrl }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { headers: { "idempotency-key": request.idempotencyKey } }),
      abortSignal: gatewayRequestSignal(request.signal),
    });
  } catch (cause) {
    const error = toGatewayProviderError(
      cause,
      "Vercel AI Gateway video submission failed",
    );
    const gatewayErrorType = error.httpStatus === 402
      ? gatewayResponseErrorType(cause)
      : null;
    // Submission failures otherwise become only a generic user error. Record
    // the status and model, never the response body, prompt, or signed URLs.
    console.warn("Gateway video submission failed", {
      model: request.model,
      httpStatus: error.httpStatus,
      errorType: cause instanceof Error ? cause.name : typeof cause,
      ...(gatewayErrorType === null
        ? {}
        : { gatewayErrorType }),
    });
    throw new AiVideoSubmissionError(error.message, {
      outcome: gatewayExecutionOf(cause),
      cause,
      ...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus }),
    });
  }

  const jobId = gatewayJobIdOf(result.providerMetadata);
  if (!jobId) {
    // The generation was accepted and is being billed, but nothing came back
    // that could name it again. Treating that as a definite failure would
    // refund a job that is still running, so it stays unknown.
    throw new AiVideoSubmissionError(
      "Vercel AI Gateway accepted a video job without returning its id",
      { outcome: "unknown" },
    );
  }
  return {
    id: jobId,
    status: "pending",
    error: null,
    ...costOf(result.providerMetadata),
  };
}

export async function getGatewayVideoJob(
  ref: AiVideoJobRef,
): Promise<AiVideoJobInfo> {
  if (!ref.model) {
    // A status request is addressed by model as well as by id, and a row from
    // before the model column cannot name one.
    throw new AiProviderError(
      "Vercel AI Gateway video job has no model to check its status against",
    );
  }

  let status: Awaited<ReturnType<typeof getVideoStatus>>;
  try {
    status = await getVideoStatus(createGatewayClient().videoModel(ref.model), {
      operation: { gatewayJobId: ref.providerJobId },
      abortSignal: gatewayRequestSignal(ref.signal),
    });
  } catch (cause) {
    throw toGatewayProviderError(cause, "Vercel AI Gateway video poll failed");
  }

  if (status.status === "completed") {
    const actualCost = await completedVideoCost(status.providerMetadata, ref.model);
    if (actualCost === undefined) {
      // Gateway usage events can be ingested after video completion. The
      // finished video is still usable now; its reservation is settled later.
      // Keep only field names in the log; metadata may contain signed video
      // URLs and a per-job webhook signing secret.
      const metadata = status.providerMetadata;
      const fields = (value: unknown) =>
        typeof value === "object" && value !== null
          ? Object.keys(value).filter((key) => key !== "webhookSigningSecret").slice(0, 12)
          : [];
      const gateway = typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>).gateway
        : undefined;
      const asyncJob = typeof gateway === "object" && gateway !== null
        ? (gateway as Record<string, unknown>).asyncJob
        : undefined;
      console.warn("Gateway video completed without provider cost", {
        model: ref.model,
        metadataFields: fields(metadata),
        gatewayFields: fields(gateway),
        asyncJobFields: fields(asyncJob),
      });
    }
    return {
      id: ref.providerJobId,
      status: "completed",
      error: null,
      result: { videos: status.videos } satisfies GatewayVideoResult,
      ...(actualCost === undefined ? {} : { providerCostUsd: actualCost }),
    };
  }
  if (status.status === "error") {
    // The wire has a fourth state, "cancelled", which the SDK folds into this
    // one. Both end the job the same way here.
    return {
      id: ref.providerJobId,
      status: "failed",
      error: status.error,
      ...costOf(status.providerMetadata),
    };
  }
  return {
    id: ref.providerJobId,
    status: "pending",
    error: null,
    ...costOf(status.providerMetadata),
  };
}

async function readBoundedBytes(response: Response): Promise<ArrayBuffer> {
  // Counted through the stream rather than after arrayBuffer(): a chunked
  // reply declares no length, so measuring the buffer means the whole video
  // is already in the isolate before it is refused.
  try {
    return await readBoundedGatewayBytes(
      response,
      MAX_AI_GENERATED_VIDEO_BYTES,
      "video",
    );
  } catch (cause) {
    throw new InvalidAiProviderOutputError(
      "Vercel AI Gateway video exceeds the size limit",
      { cause },
    );
  }
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  // Bound both the encoded input and its decoded size before atob retains a
  // second large string. The final quartet can encode one, two, or three
  // bytes, so its padding matters even when the encoded length is at the cap.
  const maximumEncodedLength = Math.ceil(MAX_AI_GENERATED_VIDEO_BYTES / 3) * 4;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (
    value.length > maximumEncodedLength ||
    Math.floor(value.length * 3 / 4) - padding > MAX_AI_GENERATED_VIDEO_BYTES
  ) {
    throw new InvalidAiProviderOutputError("Vercel AI Gateway video exceeds the size limit");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new InvalidAiProviderOutputError("Vercel AI Gateway returned invalid base64 video", { cause });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function downloadGatewayVideoContent(
  job: AiVideoJobInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<AiVideoContent> {
  const result = job.result as GatewayVideoResult | undefined;
  const video = result?.videos?.[0];
  if (!video) {
    throw new InvalidAiProviderOutputError(
      "Vercel AI Gateway reported a finished video with nothing in it",
    );
  }

  let bytes: ArrayBuffer;
  let declaredMimeType = video.mediaType ?? "";
  if (video.type === "url") {
    if (!video.url) {
      throw new InvalidAiProviderOutputError(
        "Vercel AI Gateway reported a hosted video without a URL",
      );
    }
    // Hosted results expire; the bytes are fetched now and saved, never
    // referenced later.
    let response: Response;
    try {
      response = await fetchImpl(video.url, {
        signal: gatewayRequestSignal(undefined),
      });
    } catch (cause) {
      throw new AiProviderError(
        "Vercel AI Gateway video download failed",
        { cause, execution: "unknown" },
      );
    }
    if (!response.ok) {
      throw new AiProviderError(
        `Vercel AI Gateway video download failed: ${response.status}`,
        { httpStatus: response.status, execution: "unknown" },
      );
    }
    bytes = await readBoundedBytes(response);
    if (!declaredMimeType) {
      declaredMimeType = response.headers.get("content-type") ?? "";
    }
  } else if (video.type === "base64" && typeof video.data === "string") {
    bytes = base64ToArrayBuffer(video.data);
  } else if (video.type === "binary" && video.data instanceof Uint8Array) {
    // The provider spec allows it; the Gateway's own wire schema does not emit
    // it today. Handled rather than assumed away.
    if (video.data.byteLength > MAX_AI_GENERATED_VIDEO_BYTES) {
      throw new InvalidAiProviderOutputError("Vercel AI Gateway video exceeds the size limit");
    }
    bytes = video.data.slice().buffer;
  } else {
    throw new InvalidAiProviderOutputError(
      `Vercel AI Gateway returned an unreadable video (${video.type})`,
    );
  }

  try {
    const { mimeType, extension } = inspectGeneratedVideo(
      bytes,
      declaredMimeType,
    );
    return { bytes, mimeType, extension };
  } catch (cause) {
    if (cause instanceof InvalidGeneratedVideoError) {
      throw new InvalidAiProviderOutputError(
        "Vercel AI Gateway returned invalid video bytes",
        { cause },
      );
    }
    throw cause;
  }
}
