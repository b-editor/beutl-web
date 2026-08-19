import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_MAX_IMAGE_REFERENCES,
  type AiImageAspectRatio,
  type AiImageBackground,
} from "@beutl/core";
import {
  createPublicOpenRouterClient,
  toAiProviderError,
} from "./openrouter";

// What each image model will accept, read from the provider.
//
// The same problem the video screens had: a fixed set of options produces
// requests the provider refuses after the usage is reserved. GPT Image-1 takes
// only 1:1, 3:2 and 2:3 — asking it for 16:9 comes back as
// `aspect_ratio: not supported` — while Seedream takes a dozen more, and only
// some models take a seed, a transparent background or a reference image.
//
// Unlike video, this is one request per model rather than one for the whole
// list: the provider publishes image capabilities per model endpoint.
export type AiImageModelCapabilities = {
  modelId: string;
  aspectRatios: AiImageAspectRatio[];
  // The backgrounds the model publishes, narrowed to the ones this service
  // knows how to ask for. Always holds "auto", which sends no field at all.
  backgrounds: AiImageBackground[];
  seed: boolean;
  // Whether a picture can be handed to the model at all, which every edit and
  // every image-to-image generation depends on.
  inputReferences: boolean;
  // How many, narrowed to what the price covers. Zero when the model takes
  // none.
  maxReferenceImages: number;
  // Whether a size can be asked for, which is what upscaling means here.
  resolution: boolean;
};

export type UnsupportedImageRequestReason =
  | "aspectRatio"
  | "background"
  | "seed"
  | "referenceImages"
  | "resolution";

// Unauthenticated: the endpoint is public and the admin console reads it too,
// and that worker holds no provider credentials. Short-timed so a page never
// hangs on the provider.
// What an upscale asks the provider for. A model whose sizes stop short of it
// cannot serve that operation however the rest of the request is shaped.
const UPSCALE_RESOLUTION = "4K";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  capabilities: AiImageModelCapabilities | null;
};

const cache = new Map<string, CacheEntry>();

export function clearAiImageModelCapabilitiesCache(): void {
  cache.clear();
}

// Model ids are validated as "author/slug" before they are stored, so the first
// slash is the only separator.
function splitModelId(model: string): { author: string; slug: string } | null {
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) return null;
  return { author: model.slice(0, index), slug: model.slice(index + 1) };
}

function rangeMaximum(descriptor: unknown): number | null {
  if (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "type" in descriptor &&
    descriptor.type === "range" &&
    "max" in descriptor &&
    typeof descriptor.max === "number"
  ) {
    return descriptor.max;
  }
  return null;
}

function enumValues(descriptor: unknown): string[] | null {
  if (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "type" in descriptor &&
    descriptor.type === "enum" &&
    "values" in descriptor &&
    Array.isArray(descriptor.values)
  ) {
    return descriptor.values.filter(
      (value): value is string => typeof value === "string",
    );
  }
  return null;
}

// A model is served by several provider endpoints and the router picks one that
// takes the request, so what the model accepts is the union of what its
// endpoints accept.
function toCapabilities(
  modelId: string,
  endpoints: { supportedParameters: Record<string, unknown> }[],
): AiImageModelCapabilities {
  const supported = new Set<string>();
  const ratios = new Set<string>();
  let publishedReferences: number | null = null;
  // Which values each parameter takes, unioned across the endpoints. A
  // parameter that is not an enum has no values and is judged by its presence.
  const values = new Map<string, Set<string>>();
  for (const endpoint of endpoints) {
    for (const [name, descriptor] of Object.entries(
      endpoint.supportedParameters ?? {},
    )) {
      supported.add(name);
      const listed = enumValues(descriptor);
      if (listed) {
        const known = values.get(name) ?? new Set<string>();
        for (const value of listed) known.add(value);
        values.set(name, known);
      }
      if (name === "aspect_ratio") {
        for (const value of listed ?? []) ratios.add(value);
      }
      if (name === "input_references") {
        const maximum = rangeMaximum(descriptor);
        if (maximum !== null) {
          publishedReferences = Math.max(publishedReferences ?? 0, maximum);
        }
      }
    }
  }

  // A parameter that publishes values is judged by them; one that publishes
  // none states no restriction and is judged by its presence. An absent
  // parameter is a refusal either way.
  const accepts = (name: string, value: string) => {
    const known = values.get(name);
    return known ? known.has(value) : supported.has(name);
  };

  return {
    modelId,
    // A model that publishes no ratios states no restriction, which leaves
    // every ratio this service knows how to ask for on offer.
    aspectRatios: ratios.size === 0
      ? [...AI_IMAGE_ASPECT_RATIOS]
      : AI_IMAGE_ASPECT_RATIOS.filter((ratio) => ratios.has(ratio)),
    // The values, not the key: GPT Image-1 publishes "auto" and "transparent"
    // while GPT Image-2 publishes "auto" and "opaque", so asking either for the
    // other's comes back as `background: not supported`.
    backgrounds: AI_IMAGE_BACKGROUNDS.filter(
      (value) => value === "auto" || accepts("background", value),
    ),
    seed: supported.has("seed"),
    inputReferences: supported.has("input_references"),
    // A model that publishes no count but takes references at all is trusted
    // for what this service is priced to send.
    maxReferenceImages: supported.has("input_references")
      ? Math.min(publishedReferences ?? AI_MAX_IMAGE_REFERENCES, AI_MAX_IMAGE_REFERENCES)
      : 0,
    // Upscaling asks for 4K; a model whose sizes stop at 2K cannot serve it.
    resolution: accepts("resolution", UPSCALE_RESOLUTION),
  };
}

async function loadOne(
  modelId: string,
  now: number,
): Promise<AiImageModelCapabilities | null> {
  const cached = cache.get(modelId);
  if (cached && cached.expiresAt > now) return cached.capabilities;

  const parts = splitModelId(modelId);
  if (!parts) return null;
  try {
    const client = createPublicOpenRouterClient({
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumResponseBytes: MAX_RESPONSE_BYTES,
    });
    const response = await client.images.listModelEndpoints({
      author: parts.author,
      slug: parts.slug,
    });
    const capabilities = toCapabilities(
      modelId,
      response.endpoints.map((endpoint) => ({
        supportedParameters: endpoint.supportedParameters as Record<
          string,
          unknown
        >,
      })),
    );
    cache.set(modelId, { expiresAt: now + CACHE_TTL_MS, capabilities });
    return capabilities;
  } catch (error) {
    // An outage in the capability lookup must not take image generation
    // offline: callers read a missing entry as "no restriction known".
    console.error(
      "Failed to read OpenRouter image model capabilities",
      modelId,
      toAiProviderError(error, "OpenRouter image model endpoints failed")
        .message,
    );
    cache.set(modelId, { expiresAt: now + FAILURE_CACHE_TTL_MS, capabilities: null });
    return null;
  }
}

// One lookup per model, in parallel and cached, because the provider publishes
// image capabilities per model rather than as one list.
export async function loadAiImageModelCapabilities(
  modelIds: readonly string[],
  now = Date.now(),
): Promise<Map<string, AiImageModelCapabilities>> {
  const unique = [...new Set(modelIds)];
  const loaded = await Promise.all(
    unique.map(async (modelId) => [modelId, await loadOne(modelId, now)] as const),
  );
  return new Map(
    loaded.filter((entry): entry is [string, AiImageModelCapabilities] =>
      entry[1] !== null,
    ),
  );
}

// Why the provider would refuse this request, or null if nothing rules it out.
// An unknown model yields null: the catalog decides which models exist, and
// refusing one merely missing from a stale lookup would take it offline.
export function unsupportedImageRequestReason(
  capabilities: AiImageModelCapabilities | undefined,
  request: {
    aspectRatio?: string;
    background?: AiImageBackground;
    seed?: number;
    // How many pictures the request carries.
    referenceImages?: number;
    resolution?: boolean;
  },
): UnsupportedImageRequestReason | null {
  if (!capabilities) return null;
  if (
    request.aspectRatio !== undefined &&
    !capabilities.aspectRatios.includes(request.aspectRatio as AiImageAspectRatio)
  ) {
    return "aspectRatio";
  }
  // Asking for a background the model does not publish is a refusal; "auto"
  // leaves it to the model and is always fine.
  if (
    request.background !== undefined &&
    request.background !== "auto" &&
    !capabilities.backgrounds.includes(request.background)
  ) {
    return "background";
  }
  if (request.seed !== undefined && !capabilities.seed) return "seed";
  if (
    request.referenceImages !== undefined &&
    request.referenceImages > capabilities.maxReferenceImages
  ) {
    return "referenceImages";
  }
  if (request.resolution === true && !capabilities.resolution) return "resolution";
  return null;
}

// Whether the model can serve the operation at all. An edit hands the model a
// picture, so one that takes no reference image is registered and unusable
// however the request is shaped.
export function isImageModelUsable(
  capabilities: AiImageModelCapabilities | undefined,
  requires: { referenceImages?: boolean; resolution?: boolean } = {},
): boolean {
  if (!capabilities) return true;
  if (capabilities.aspectRatios.length === 0) return false;
  if (requires.referenceImages === true && capabilities.maxReferenceImages < 1) {
    return false;
  }
  if (requires.resolution === true && !capabilities.resolution) return false;
  return true;
}
