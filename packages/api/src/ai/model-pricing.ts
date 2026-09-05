// Fetching OpenRouter's published price list for the models currently
// configured, and turning it into per-operation cost estimates.
//
// ADMIN CONSOLE ONLY, and never on a billing path: an operation is charged the
// unit price recorded when it starts, not anything derived here.
//
// These endpoints are public, so no API key is involved. That is deliberate —
// the admin Worker holds no provider credentials and does not need any to show
// costs. The SDK client used here is built without one, and with a short
// timeout: a lookup that only renders a figure on a page must not hang the
// console when the provider is slow.
import { createPublicOpenRouterClient } from "./openrouter";
import type {
  ImageModelEndpointsResponse,
  ModelResponse,
  VideoModelsListResponse,
} from "@openrouter/sdk/models";
import {
  OpenRouterError,
  ResponseValidationError,
} from "@openrouter/sdk/models/errors";
import {
  estimateImageCost,
  estimateTranscriptionCost,
  estimateTranslationCost,
  estimateVideoCost,
  type AiCostEstimate,
  type ImagePricingEntry,
} from "./cost-estimate";
import {
  AI_MAX_IMAGE_REFERENCES,
  AI_PRICING_CATALOG,
  AI_VIDEO_RESOLUTIONS,
} from "@beutl/core";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

// A video is charged per second at one rate whatever its resolution, so the
// margin has to hold at the dearest resolution a caller can ask for, not the
// one the schema happens to default to. That differs per model now: one that
// renders only at 2K is never asked for 1080p, and one that stops at 720p is
// never asked for more. AI_VIDEO_RESOLUTIONS is ordered smallest first, so the
// last one both sides offer is the dearest. Models that cannot generate audio
// are priced against the silent request shape the API forces for them.
function dearestOfferedResolution(
  supported: readonly string[] | null | undefined,
): string {
  const offered = AI_VIDEO_RESOLUTIONS.filter(
    (resolution) => !supported || supported.includes(resolution),
  );
  return offered[offered.length - 1] ?? AI_VIDEO_RESOLUTIONS[AI_VIDEO_RESOLUTIONS.length - 1]!;
}

type CacheEntry = {
  expiresAt: number;
  value: unknown | null;
  failure: "provider_unavailable" | "model_not_found" | "invalid_response" | null;
};

const cache = new Map<string, CacheEntry>();
// Five operations can share one image model, and they are estimated in
// parallel. Without this they would each open their own request, because the
// cache is only written once a response has come back.
const inflight = new Map<string, Promise<FetchOutcome>>();

function readCache(path: string, now: number): CacheEntry | null {
  const entry = cache.get(path);
  if (!entry || entry.expiresAt <= now) {
    return null;
  }
  return entry;
}

function writeCache(path: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(path, entry);
}

export function clearAiModelPricingCache(): void {
  cache.clear();
  inflight.clear();
}

type FetchOutcome =
  | { ok: true; value: unknown }
  | {
      ok: false;
      failure: "provider_unavailable" | "model_not_found" | "invalid_response";
    };

function pricingClient() {
  return createPublicOpenRouterClient({
    timeoutMs: REQUEST_TIMEOUT_MS,
    maximumResponseBytes: MAX_RESPONSE_BYTES,
  });
}

// Cached by a key of the caller's choosing rather than by URL: the same rate
// card answers for every operation that shares a model, and the SDK call that
// produces it is no longer a path this module builds.
async function fetchPricing(
  key: string,
  load: () => Promise<unknown>,
  { force, now }: { force: boolean; now: number },
): Promise<FetchOutcome> {
  if (!force) {
    const cached = readCache(key, now);
    if (cached) {
      return cached.failure
        ? { ok: false, failure: cached.failure }
        : { ok: true, value: cached.value };
    }
  }

  const pending = inflight.get(key);
  if (pending) {
    return await pending;
  }
  const request = performFetch(key, load, now).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return await request;
}

async function performFetch(
  key: string,
  load: () => Promise<unknown>,
  now: number,
): Promise<FetchOutcome> {
  try {
    const value = await load();
    writeCache(key, {
      expiresAt: now + CACHE_TTL_MS,
      value,
      failure: null,
    });
    return { ok: true, value };
  } catch (error) {
    // A model the provider has never heard of is not an outage, and asking
    // again in a minute will not change the answer. Judged by the status rather
    // than by the error class: a 404 whose body does not match what the SDK
    // expects still means the model is not there.
    // Judged by status first: a 404 means the model is not there, and any
    // other error status is the provider failing, whatever its body looked
    // like. Only a reply that arrived intact and still could not be read is
    // the provider answering something other than its published shape.
    const failure =
      error instanceof OpenRouterError && error.statusCode >= 400
        ? error.statusCode === 404
          ? "model_not_found"
          : "provider_unavailable"
        : error instanceof ResponseValidationError
          ? "invalid_response"
          : "provider_unavailable";
    if (failure === "provider_unavailable") {
      console.warn("[ai-cost] price lookup failed", {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    writeCache(key, {
      expiresAt: now + FAILURE_CACHE_TTL_MS,
      value: null,
      failure,
    });
    return { ok: false, failure };
  }
}

// Model IDs are validated as "author/slug" before they are stored, so the first
// slash is the only separator.
function splitModelId(model: string): { author: string; slug: string } | null {
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) {
    return null;
  }
  return {
    author: encodeURIComponent(model.slice(0, index)),
    slug: encodeURIComponent(model.slice(index + 1)),
  };
}

async function estimateImageOperation(
  model: string,
  referenceImages: number,
  options: { force: boolean; now: number },
): Promise<AiCostEstimate> {
  const parts = splitModelId(model);
  if (!parts) {
    return { status: "unknown", reason: "model_not_found" };
  }
  const outcome = await fetchPricing(
    `image-endpoints:${model}`,
    async () =>
      await pricingClient().images.listModelEndpoints({
        author: parts.author,
        slug: parts.slug,
      }),
    options,
  );
  if (!outcome.ok) {
    return { status: "unknown", reason: outcome.failure };
  }
  const response = outcome.value as ImageModelEndpointsResponse;
  const endpoints: ImagePricingEntry[][] = response.endpoints.map((endpoint) =>
    endpoint.pricing.map((entry) => ({
      billable: entry.billable,
      unit: entry.unit,
      costUsd: entry.costUsd,
    })),
  );
  return estimateImageCost({ endpoints, referenceImages });
}

async function loadModelPricing(
  model: string,
  options: { force: boolean; now: number },
): Promise<
  | { ok: true; prompt: number; completion: number }
  | { ok: false; reason: "provider_unavailable" | "model_not_found" | "invalid_response" }
> {
  const parts = splitModelId(model);
  if (!parts) {
    return { ok: false, reason: "model_not_found" };
  }
  const outcome = await fetchPricing(
    `model:${model}`,
    async () =>
      await pricingClient().models.get({
        author: parts.author,
        slug: parts.slug,
      }),
    options,
  );
  if (!outcome.ok) {
    return { ok: false, reason: outcome.failure };
  }
  const pricing = (outcome.value as ModelResponse).data.pricing;
  return {
    ok: true,
    prompt: Number(pricing.prompt),
    completion: Number(pricing.completion ?? "0"),
  };
}

async function estimateVideoOperation(
  model: string,
  options: { force: boolean; now: number },
): Promise<AiCostEstimate> {
  const outcome = await fetchPricing(
    "video-models",
    async () => await pricingClient().videoGeneration.listVideosModels(),
    options,
  );
  if (!outcome.ok) {
    return { status: "unknown", reason: outcome.failure };
  }
  const entry = (outcome.value as VideoModelsListResponse).data.find(
    (candidate) => candidate.id === model,
  );
  if (!entry) {
    return { status: "unknown", reason: "model_not_found" };
  }
  if (!entry.pricingSkus) {
    return { status: "unknown", reason: "unsupported_pricing_shape" };
  }
  return estimateVideoCost({
    pricingSkus: entry.pricingSkus,
    resolution: dearestOfferedResolution(entry.supportedResolutions),
    withAudio: entry.generateAudio ?? true,
  });
}

export type AiCostEstimateEntry = {
  operation: string;
  model: string;
  estimate: AiCostEstimate;
};

export type AiCostEstimates = {
  fetchedAt: Date;
  entries: AiCostEstimateEntry[];
};

// Never throws. Every model on offer gets an entry, so a single failing lookup
// cannot take the settings page down with it. Operations that share a model
// still cost one fetch between them: the rate card is cached per URL path.
export async function loadAiCostEstimates({
  modelsOf,
  now = new Date(),
  force = false,
}: {
  modelsOf: (operation: string) => string[];
  now?: Date;
  force?: boolean;
}): Promise<AiCostEstimates> {
  const options = { force, now: now.getTime() };
  const pairs = Object.keys(AI_PRICING_CATALOG).flatMap((operation) => {
    let models: string[] = [];
    try {
      models = modelsOf(operation);
    } catch (error) {
      console.warn("[ai-cost] model lookup failed", {
        operation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return models.map((model) => ({ operation, model }));
  });

  const entries = await Promise.all(
    pairs.map(async ({ operation, model }): Promise<AiCostEstimateEntry> => {
      try {
        const estimate = await estimateOperation(operation, model, options);
        return { operation, model, estimate };
      } catch (error) {
        console.warn("[ai-cost] estimate failed", {
          operation,
          model,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          operation,
          model,
          estimate: { status: "unknown", reason: "provider_unavailable" },
        };
      }
    }),
  );

  return { fetchedAt: now, entries };
}

// Entries are keyed by the pair, since one operation now has several.
export function aiCostEstimateKey(operation: string, model: string): string {
  return `${operation}\u0000${model}`;
}

async function estimateOperation(
  operation: string,
  model: string,
  options: { force: boolean; now: number },
): Promise<AiCostEstimate> {
  if (operation === "video.generate") {
    return await estimateVideoOperation(model, options);
  }
  if (operation.startsWith("image.")) {
    // Every edit sends exactly one source image. Generation is costed with the
    // maximum reference set because the configured unit price must cover its
    // most expensive valid request shape.
    return await estimateImageOperation(
      model,
      operation === "image.generate" ? AI_MAX_IMAGE_REFERENCES : 1,
      options,
    );
  }

  const pricing = await loadModelPricing(model, options);
  if (!pricing.ok) {
    return { status: "unknown", reason: pricing.reason };
  }
  if (operation === "audio.transcribe") {
    return estimateTranscriptionCost({
      model,
      promptPriceUsd: pricing.prompt,
    });
  }
  if (operation === "subtitle.translate") {
    return estimateTranslationCost({
      promptPriceUsd: pricing.prompt,
      completionPriceUsd: pricing.completion,
    });
  }
  return { status: "unknown", reason: "unsupported_pricing_shape" };
}
