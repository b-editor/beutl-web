// What the Gateway publishes about its video models.
//
// Read from GET /v1/models, which needs no credentials — the same reason
// OpenRouter's capability list is read unauthenticated: the admin console reads
// it too, and that worker holds no provider key.
//
// Two warnings about this data. `video_capabilities` and its
// `supported_operations` appear nowhere in Vercel's documentation; they exist
// only in the live response, so the field names are unversioned and a shape
// change must degrade to "nothing known" rather than take video offline. And
// the list is the provider's, not this service's: a model offering 4K or 768p
// has those dropped here, because an estimate is priced against the largest
// shape this service will actually ask for.

import { z } from "zod";
import { AiProviderError } from "../errors";
import {
  UNSTATED_VIDEO_INPUT_LIMITS,
  type AiVideoModelDescriptor,
  type AiVideoModelInputLimits,
} from "../types";
import { aiVideoResolutionOfGatewayLabel } from "./resolution";

const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Everything is optional: a model that publishes nothing about a field is
// stating no restriction, which is not the same as restricting it to nothing.
// What one kind of input is capped at. Every field optional: a model that
// publishes a count but no size is stating one restriction, not two.
const inputLimitSchema = z.object({
  max_count: z.number().nullish(),
  max_file_size_mb: z.number().nullish(),
  min_duration_seconds: z.number().nullish(),
  max_duration_seconds: z.number().nullish(),
});

const inputLimitsSchema = z.object({
  image: inputLimitSchema.nullish(),
  video: inputLimitSchema.nullish(),
  audio: inputLimitSchema.nullish(),
  text: z.object({ max_chars: z.number().nullish() }).nullish(),
  max_total_inputs: z.number().nullish(),
});

const videoCapabilitiesSchema = z.object({
  supported_operations: z.array(z.string()).nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_durations_seconds: z.array(z.number()).nullish(),
  generate_audio: z.boolean().nullish(),
  // Undocumented like the rest of this block, and read defensively: a shape
  // change here must cost the extra allowance, not take video offline.
  input_limits: inputLimitsSchema.nullish(),
});

const modelSchema = z.object({
  id: z.string().min(1),
  type: z.string().nullish(),
  video_capabilities: videoCapabilitiesSchema.nullish(),
});

const modelsResponseSchema = z.object({
  data: z.array(z.unknown()),
});

/** Operation names seen in `supported_operations`, as of 2026-09. */
export const GATEWAY_VIDEO_OPERATIONS = {
  textToVideo: "text-to-video",
  imageToVideo: "image-to-video",
  firstLastFrame: "first-last-frame",
  referenceToVideo: "reference-to-video",
  motionControl: "motion-control",
  videoEditing: "video-editing",
  extendVideo: "extend-video",
} as const;

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** A count or size the provider published, or null for anything unusable. */
function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function wholePositive(value: number | null | undefined): number | null {
  const parsed = positive(value);
  return parsed === null ? null : Math.floor(parsed);
}

function toInputLimits(
  published: z.infer<typeof inputLimitsSchema> | null | undefined,
): AiVideoModelInputLimits {
  if (!published) return UNSTATED_VIDEO_INPUT_LIMITS;
  const megabytes = (value: number | null | undefined): number | null => {
    const parsed = positive(value);
    return parsed === null ? null : Math.floor(parsed * BYTES_PER_MEGABYTE);
  };
  return {
    maxImages: wholePositive(published.image?.max_count),
    maxImageBytes: megabytes(published.image?.max_file_size_mb),
    maxVideos: wholePositive(published.video?.max_count),
    maxVideoBytes: megabytes(published.video?.max_file_size_mb),
    minVideoDurationSeconds: positive(published.video?.min_duration_seconds),
    maxVideoDurationSeconds: positive(published.video?.max_duration_seconds),
    // 音声は枚数を書かないモデルがある。ブロックがあるなら 1 つは取る。
    maxAudio: published.audio
      ? wholePositive(published.audio.max_count) ?? 1
      : null,
    maxAudioBytes: megabytes(published.audio?.max_file_size_mb),
    minAudioDurationSeconds: positive(published.audio?.min_duration_seconds),
    maxAudioDurationSeconds: positive(published.audio?.max_duration_seconds),
    maxPromptCharacters: wholePositive(published.text?.max_chars),
    maxTotalInputs: wholePositive(published.max_total_inputs),
  };
}

// Which frames a model will take.
//
// Derived rather than read: the Gateway has no field for it. Returning an
// explicit list where OpenRouter returns null is the stricter and more honest
// answer — a text-to-video model takes no frames at all, and calling that
// "unrestricted" would offer a first frame on a model that refuses one.
function frameImagesOf(operations: readonly string[]): string[] {
  const frames: string[] = [];
  if (
    operations.includes(GATEWAY_VIDEO_OPERATIONS.imageToVideo) ||
    operations.includes(GATEWAY_VIDEO_OPERATIONS.firstLastFrame)
  ) {
    frames.push("first_frame");
  }
  if (operations.includes(GATEWAY_VIDEO_OPERATIONS.firstLastFrame)) {
    frames.push("last_frame");
  }
  return frames;
}

export function toVideoModelDescriptor(
  model: z.infer<typeof modelSchema>,
): AiVideoModelDescriptor {
  const capabilities = model.video_capabilities ?? {};
  const operations = capabilities.supported_operations ?? [];

  const resolutions = capabilities.supported_resolutions
    ? [
        ...new Set(
          capabilities.supported_resolutions
            .map(aiVideoResolutionOfGatewayLabel)
            .filter((label): label is NonNullable<typeof label> =>
              label !== null,
            ),
        ),
      ]
    : null;

  return {
    id: model.id,
    supportedResolutions: resolutions,
    supportedDurations: capabilities.supported_durations_seconds ?? null,
    supportedAspectRatios: capabilities.supported_aspect_ratios ?? null,
    // An empty list only when the operations are published and name no frame
    // mode; an unpublished list stays null, meaning nothing is stated.
    supportedFrameImages: capabilities.supported_operations
      ? frameImagesOf(operations)
      : null,
    generateAudio: capabilities.generate_audio ?? null,
    // The Gateway publishes nothing about deterministic seeds, and the request
    // API takes one, so nothing is stated rather than nothing is supported.
    seed: null,
    // A motion-control model publishes resolutions, lengths and shapes like any
    // other; only its operations say it cannot take a plain prompt.
    supportsPromptToVideo: capabilities.supported_operations
      ? operations.includes(GATEWAY_VIDEO_OPERATIONS.textToVideo) ||
        operations.includes(GATEWAY_VIDEO_OPERATIONS.imageToVideo)
      : null,
    supportsReferenceToVideo: capabilities.supported_operations
      ? operations.includes(GATEWAY_VIDEO_OPERATIONS.referenceToVideo)
      : null,
    supportsVideoEditing: capabilities.supported_operations
      ? operations.includes(GATEWAY_VIDEO_OPERATIONS.videoEditing)
      : null,
    supportsVideoExtension: capabilities.supported_operations
      ? operations.includes(GATEWAY_VIDEO_OPERATIONS.extendVideo)
      : null,
    supportsMotionControl: capabilities.supported_operations
      ? operations.includes(GATEWAY_VIDEO_OPERATIONS.motionControl)
      : null,
    inputLimits: toInputLimits(capabilities.input_limits),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AiProviderError(
      "Vercel AI Gateway model list exceeds the size limit",
    );
  }
  const text = await response.text();
  // Checked after the fact as well: a chunked reply declares no length, and a
  // worker must not be asked to parse an unbounded body.
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AiProviderError(
      "Vercel AI Gateway model list exceeds the size limit",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AiProviderError("Vercel AI Gateway returned invalid JSON", {
      cause,
    });
  }
}

/**
 * Every video model the Gateway offers.
 *
 * A single entry that does not parse is dropped rather than failing the list:
 * the shape is undocumented, and one new field on one model must not take the
 * other thirty-four offline.
 */
export async function listGatewayVideoModels(
  fetchImpl: typeof fetch = fetch,
): Promise<AiVideoModelDescriptor[]> {
  let response: Response;
  try {
    response = await fetchImpl(MODELS_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new AiProviderError("Vercel AI Gateway model list failed", { cause });
  }
  if (!response.ok) {
    throw new AiProviderError(
      `Vercel AI Gateway model list failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }

  const parsed = modelsResponseSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) {
    throw new AiProviderError(
      "Vercel AI Gateway returned an unreadable model list",
      { cause: parsed.error },
    );
  }

  const descriptors: AiVideoModelDescriptor[] = [];
  for (const entry of parsed.data.data) {
    const model = modelSchema.safeParse(entry);
    if (!model.success || model.data.type !== "video") continue;
    descriptors.push(toVideoModelDescriptor(model.data));
  }
  return descriptors;
}
