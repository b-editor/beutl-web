import {
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  type AiVideoAspectRatio,
  type AiVideoResolution,
} from "@beutl/core";
import { listVideoModels } from "./openrouter-video";

// What a video model will actually accept, narrowed to what this service can
// ask for.
//
// The parameters a video request may carry differ per model: MiniMax H3 renders
// only at 2K and refuses anything shorter than five seconds, Veo 3.1 takes 4/6/8
// seconds at 720p or 1080p, Seedance 2.5 stops at 720p. A fixed list of options
// was right while there was one model; with several registered it produces
// requests the provider rejects, and the user is charged nothing but told only
// that "the provider failed".
//
// A field the provider publishes as null means it states no restriction, which
// is not the same as restricting to nothing — those stay unconstrained.
export type AiVideoModelCapabilities = {
  modelId: string;
  resolutions: AiVideoResolution[];
  durations: number[];
  aspectRatios: AiVideoAspectRatio[];
  generateAudio: boolean;
  seed: boolean;
  frameImages: boolean;
};

export type UnsupportedVideoRequestReason =
  | "resolution"
  | "duration"
  | "aspectRatio"
  | "generateAudio"
  | "seed"
  | "frameImages";

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  capabilities: Map<string, AiVideoModelCapabilities>;
};

let cache: CacheEntry | null = null;

export function clearAiVideoModelCapabilitiesCache(): void {
  cache = null;
}

function intersect<T extends string | number>(
  offered: readonly T[],
  supported: readonly (string | number)[] | null | undefined,
): T[] {
  if (!supported) return [...offered];
  return offered.filter((value) => supported.includes(value));
}

// The provider reports resolutions as free-form strings ("720p", "2K"), so the
// comparison is by value rather than by a shared type.
function toCapabilities(model: {
  id: string;
  supportedResolutions: readonly string[] | null;
  supportedDurations: readonly number[] | null;
  supportedAspectRatios: readonly string[] | null;
  supportedFrameImages: readonly string[] | null;
  generateAudio: boolean | null;
  seed: boolean | null;
}): AiVideoModelCapabilities {
  return {
    modelId: model.id,
    resolutions: intersect(AI_VIDEO_RESOLUTIONS, model.supportedResolutions),
    durations: intersect(AI_VIDEO_DURATIONS_SECONDS, model.supportedDurations),
    aspectRatios: intersect(
      AI_VIDEO_ASPECT_RATIOS,
      model.supportedAspectRatios,
    ),
    generateAudio: model.generateAudio ?? true,
    seed: model.seed ?? true,
    frameImages: (model.supportedFrameImages?.length ?? 1) > 0,
  };
}

// One request covers every model, so the whole list is cached rather than each
// model separately.
//
// A failed lookup caches an empty map for a shorter while: callers treat an
// absent entry as "no restriction known", so an outage at the provider leaves
// video generation working exactly as it did before capabilities were consulted
// rather than taking it offline.
export async function loadAiVideoModelCapabilities(
  now = Date.now(),
): Promise<Map<string, AiVideoModelCapabilities>> {
  if (cache && cache.expiresAt > now) return cache.capabilities;
  let capabilities: Map<string, AiVideoModelCapabilities>;
  let ttl = CACHE_TTL_MS;
  try {
    const models = await listVideoModels();
    capabilities = new Map(
      models.map((model) => [model.id, toCapabilities(model)]),
    );
  } catch (error) {
    console.error("Failed to read OpenRouter video model capabilities", error);
    capabilities = new Map();
    ttl = FAILURE_CACHE_TTL_MS;
  }
  cache = { expiresAt: now + ttl, capabilities };
  return capabilities;
}

// Why the provider would refuse this request, or null if nothing rules it out.
//
// An unknown model yields null: the catalog decides which models exist, and
// refusing one merely missing from the provider's list would take a working
// model offline on a stale response.
export function unsupportedVideoRequestReason(
  capabilities: AiVideoModelCapabilities | undefined,
  request: {
    resolution: string;
    durationSeconds: number;
    aspectRatio?: string;
    generateAudio?: boolean;
    seed?: number;
    frameImages?: boolean;
  },
): UnsupportedVideoRequestReason | null {
  if (!capabilities) return null;
  if (!capabilities.resolutions.includes(request.resolution as AiVideoResolution)) {
    return "resolution";
  }
  if (!capabilities.durations.includes(request.durationSeconds)) {
    return "duration";
  }
  if (
    request.aspectRatio !== undefined &&
    !capabilities.aspectRatios.includes(request.aspectRatio as AiVideoAspectRatio)
  ) {
    return "aspectRatio";
  }
  // Asking for audio from a model that cannot produce it is a refusal; asking
  // it not to is always fine.
  if (request.generateAudio === true && !capabilities.generateAudio) {
    return "generateAudio";
  }
  if (request.seed !== undefined && !capabilities.seed) {
    return "seed";
  }
  if (request.frameImages === true && !capabilities.frameImages) {
    return "frameImages";
  }
  return null;
}

// Whether the model can serve any request at all. A model that shares no
// resolution, duration or aspect ratio with this service is registered but
// unusable, and offering it would only ever produce a refused request.
export function isVideoModelUsable(
  capabilities: AiVideoModelCapabilities | undefined,
): boolean {
  if (!capabilities) return true;
  return (
    capabilities.resolutions.length > 0 &&
    capabilities.durations.length > 0 &&
    capabilities.aspectRatios.length > 0
  );
}
