// Fetching OpenRouter's published price list for the models currently
// configured, and turning it into per-operation cost estimates.
//
// ADMIN CONSOLE ONLY, and never on a billing path: an operation is charged the
// unit price recorded when it starts, not anything derived here.
//
// These endpoints are public, so no API key is involved. That is deliberate —
// the admin Worker holds no provider credentials and does not need any to show
// costs. The dedicated client below is small on purpose: the request helper in
// ./openrouter requires a key, allows 120 seconds, and returns a release
// contract for large bodies, none of which suits a short anonymous GET.
import { z } from "zod";
import { readBoundedResponseText } from "./openrouter";
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

// A video is charged per second at one rate whatever its resolution, so the
// margin has to hold at the dearest resolution a caller can ask for, not the
// one the schema happens to default to. The app never requests 4K or silent
// video, so those shapes stay out of the estimate.
const VIDEO_RESOLUTION = AI_VIDEO_RESOLUTIONS.reduce((highest, candidate) =>
  Number.parseInt(candidate, 10) > Number.parseInt(highest, 10)
    ? candidate
    : highest,
);
const VIDEO_WITH_AUDIO = true;

const modelPricingSchema = z.object({
  data: z.object({
    pricing: z.object({
      prompt: z.string(),
      completion: z.string().optional(),
    }),
  }),
});

const imageEndpointsSchema = z.object({
  endpoints: z.array(
    z.object({
      pricing: z.array(
        z.object({
          billable: z.string(),
          unit: z.string(),
          cost_usd: z.number(),
        }),
      ),
    }),
  ),
});

const videoModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      pricing_skus: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

type CacheEntry = {
  expiresAt: number;
  value: unknown | null;
  failure: "provider_unavailable" | "model_not_found" | null;
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
  | { ok: false; failure: "provider_unavailable" | "model_not_found" };

async function fetchPricing(
  path: string,
  { force, now }: { force: boolean; now: number },
): Promise<FetchOutcome> {
  if (!force) {
    const cached = readCache(path, now);
    if (cached) {
      return cached.failure
        ? { ok: false, failure: cached.failure }
        : { ok: true, value: cached.value };
    }
  }

  const pending = inflight.get(path);
  if (pending) {
    return await pending;
  }
  const request = performFetch(path, now).finally(() => {
    inflight.delete(path);
  });
  inflight.set(path, request);
  return await request;
}

async function performFetch(
  path: string,
  now: number,
): Promise<FetchOutcome> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      writeCache(path, {
        expiresAt: now + FAILURE_CACHE_TTL_MS,
        value: null,
        failure: "model_not_found",
      });
      return { ok: false, failure: "model_not_found" };
    }
    if (!response.ok) {
      throw new Error(`OpenRouter responded ${response.status}`);
    }
    const text = await readBoundedResponseText(
      response,
      MAX_RESPONSE_BYTES,
      "OpenRouter price response",
    );
    const value = JSON.parse(text) as unknown;
    writeCache(path, {
      expiresAt: now + CACHE_TTL_MS,
      value,
      failure: null,
    });
    return { ok: true, value };
  } catch (error) {
    console.warn("[ai-cost] price lookup failed", {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    writeCache(path, {
      expiresAt: now + FAILURE_CACHE_TTL_MS,
      value: null,
      failure: "provider_unavailable",
    });
    return { ok: false, failure: "provider_unavailable" };
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
    `/images/models/${parts.author}/${parts.slug}/endpoints`,
    options,
  );
  if (!outcome.ok) {
    return { status: "unknown", reason: outcome.failure };
  }
  const parsed = imageEndpointsSchema.safeParse(outcome.value);
  if (!parsed.success) {
    return { status: "unknown", reason: "invalid_response" };
  }
  const endpoints: ImagePricingEntry[][] = parsed.data.endpoints.map(
    (endpoint) =>
      endpoint.pricing.map((entry) => ({
        billable: entry.billable,
        unit: entry.unit,
        costUsd: entry.cost_usd,
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
    `/model/${parts.author}/${parts.slug}`,
    options,
  );
  if (!outcome.ok) {
    return { ok: false, reason: outcome.failure };
  }
  const parsed = modelPricingSchema.safeParse(outcome.value);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_response" };
  }
  return {
    ok: true,
    prompt: Number(parsed.data.data.pricing.prompt),
    completion: Number(parsed.data.data.pricing.completion ?? "0"),
  };
}

async function estimateVideoOperation(
  model: string,
  options: { force: boolean; now: number },
): Promise<AiCostEstimate> {
  const outcome = await fetchPricing("/videos/models", options);
  if (!outcome.ok) {
    return { status: "unknown", reason: outcome.failure };
  }
  const parsed = videoModelsSchema.safeParse(outcome.value);
  if (!parsed.success) {
    return { status: "unknown", reason: "invalid_response" };
  }
  const entry = parsed.data.data.find((candidate) => candidate.id === model);
  if (!entry) {
    return { status: "unknown", reason: "model_not_found" };
  }
  if (!entry.pricing_skus) {
    return { status: "unknown", reason: "unsupported_pricing_shape" };
  }
  return estimateVideoCost({
    pricingSkus: entry.pricing_skus,
    resolution: VIDEO_RESOLUTION,
    withAudio: VIDEO_WITH_AUDIO,
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

// Never throws. Every operation gets an entry, so a single failing lookup
// cannot take the settings page down with it.
export async function loadAiCostEstimates({
  modelOf,
  now = new Date(),
  force = false,
}: {
  modelOf: (operation: string) => string;
  now?: Date;
  force?: boolean;
}): Promise<AiCostEstimates> {
  const options = { force, now: now.getTime() };
  const operations = Object.keys(AI_PRICING_CATALOG);

  const entries = await Promise.all(
    operations.map(async (operation): Promise<AiCostEstimateEntry> => {
      let model = "";
      try {
        model = modelOf(operation);
        const estimate = await estimateOperation(operation, model, options);
        return { operation, model, estimate };
      } catch (error) {
        console.warn("[ai-cost] estimate failed", {
          operation,
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

async function estimateOperation(
  operation: string,
  model: string,
  options: { force: boolean; now: number },
): Promise<AiCostEstimate> {
  if (operation === "video.generate") {
    return await estimateVideoOperation(model, options);
  }
  if (operation.startsWith("image.")) {
    // An edit always sends its source, and a generation may be guided by a
    // reference at the same price, so both are costed with one input image:
    // this figure exists to check that a price covers its cost, and the run
    // that sends nothing is the cheap one.
    return await estimateImageOperation(model, AI_MAX_IMAGE_REFERENCES, options);
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
