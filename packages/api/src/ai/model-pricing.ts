// Fetching the published price list for the models currently configured, and
// turning it into per-operation cost estimates.
//
// Used by the admin catalog and by the conservative reservation made before a
// provider call. The final charge never comes from this estimate: it is settled
// from provider-reported cost, or from the unbuffered estimate only when the
// provider supplies no actual cost.
//
// These endpoints are public, so no API key is involved. That is deliberate —
// the admin Worker holds no provider credentials and does not need any to show
// costs. The SDK client used here is built without one, and with a short
// timeout: a lookup that only renders a figure on a page must not hang the
// console when the provider is slow.
//
// A model is looked up at the provider that serves it. Asking the wrong one is
// not a missing figure but a wrong statement: the console reports a model the
// other provider has never heard of as "not found", which reads as a broken
// registration rather than as a rate card this module never fetched.
import { createPublicOpenRouterClient } from "./openrouter";
import { AiProviderError, InvalidAiProviderOutputError } from "./providers/errors";
import { DEFAULT_AI_PROVIDER_ID } from "./providers/registry";
import {
  gatewayDearestVideoRate,
  loadGatewayImagePrices,
  loadGatewayRateCard,
  type GatewayImagePrice,
  type GatewayRateCard,
} from "./providers/vercel-gateway/pricing";
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
  type AiCostUnknownReason,
  type ImagePricingEntry,
} from "./cost-estimate";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_MAX_IMAGE_REFERENCES,
  AI_PRICING_CATALOG,
  AI_VIDEO_RESOLUTIONS,
} from "@beutl/core";
import {
  clearAiImageModelCapabilitiesCache,
  imageCapabilityOf,
  loadAiImageModelCapabilities,
  type AiImageModelCapabilities,
} from "./image-model-capabilities";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

// Admin estimates use the dearest supported shape, while concrete reservations
// use the submitted resolution and audio flag. AI_VIDEO_RESOLUTIONS is ordered
// smallest first, so the last resolution both sides offer is the admin bound.
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
    const status =
      error instanceof OpenRouterError
        ? error.statusCode
        : error instanceof AiProviderError
          ? error.httpStatus
          : null;
    const failure =
      status !== null && status !== undefined && status >= 400
        ? status === 404
          ? "model_not_found"
          : "provider_unavailable"
        : error instanceof ResponseValidationError || error instanceof InvalidAiProviderOutputError
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
    author: model.slice(0, index),
    slug: model.slice(index + 1),
  };
}

function imageEndpointReferenceMaximum(
  supportedParameters: unknown,
): number {
  if (
    typeof supportedParameters !== "object" ||
    supportedParameters === null ||
    !("input_references" in supportedParameters)
  ) {
    return 0;
  }
  const descriptor = supportedParameters.input_references;
  if (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "type" in descriptor &&
    descriptor.type === "range" &&
    "max" in descriptor &&
    typeof descriptor.max === "number" &&
    Number.isFinite(descriptor.max) &&
    descriptor.max >= 0
  ) {
    return Math.min(Math.floor(descriptor.max), AI_MAX_IMAGE_REFERENCES);
  }
  // Presence without a published maximum has the same unrestricted meaning
  // as the capability parser, narrowed to what this service is priced to send.
  return AI_MAX_IMAGE_REFERENCES;
}

function imageEndpointEnumValues(
  supportedParameters: unknown,
  name: string,
): string[] | null | undefined {
  if (
    typeof supportedParameters !== "object" ||
    supportedParameters === null ||
    !(name in supportedParameters)
  ) {
    return undefined;
  }
  const descriptor = (supportedParameters as Record<string, unknown>)[name];
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

function imageEndpointAccepts(
  supportedParameters: unknown,
  name: string,
  value: string,
): boolean {
  if (
    typeof supportedParameters !== "object" ||
    supportedParameters === null ||
    !(name in supportedParameters)
  ) {
    return false;
  }
  const values = imageEndpointEnumValues(supportedParameters, name);
  return values === null || values?.includes(value) === true;
}

function imageEndpointSupportsOperation(
  supportedParameters: unknown,
  operation: string,
  modelPublishesAspectRatios: boolean,
): boolean {
  if (operation === "image.generate") {
    const ratios = imageEndpointEnumValues(
      supportedParameters,
      "aspect_ratio",
    );
    return ratios === undefined
      ? !modelPublishesAspectRatios
      : ratios === null || ratios.length === 0 || ratios.some((ratio) =>
          (AI_IMAGE_ASPECT_RATIOS as readonly string[]).includes(ratio)
        );
  }
  if (imageEndpointReferenceMaximum(supportedParameters) < 1) return false;
  if (operation === "image.edit.remove_background") {
    return imageEndpointAccepts(
      supportedParameters,
      "background",
      "transparent",
    );
  }
  if (operation === "image.edit.upscale") {
    return imageEndpointAccepts(supportedParameters, "resolution", "4K");
  }
  return true;
}

async function estimateImageOperation(
  model: string,
  operation: string,
  referenceImages: number,
  correlateEndpointCapabilities: boolean,
  options: { force: boolean; now: number },
  request?: AiCostRequestShape,
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
  const modelPublishesAspectRatios = response.endpoints.some((endpoint) =>
    (imageEndpointEnumValues(endpoint.supportedParameters, "aspect_ratio") ?? [])
      .length > 0
  );
  const applicable = correlateEndpointCapabilities
    ? response.endpoints.filter((endpoint) => {
        const parameters = endpoint.supportedParameters;
        if (!imageEndpointSupportsOperation(
          parameters,
          operation,
          modelPublishesAspectRatios,
        )) return false;
        if (!request) return true;
        if ((request.referenceImages ?? referenceImages) > imageEndpointReferenceMaximum(parameters)) return false;
        const ratios = imageEndpointEnumValues(parameters, "aspect_ratio");
        if (request.aspectRatio && ratios?.length && !ratios.includes(request.aspectRatio)) return false;
        return !request.background || request.background === "auto" ||
          imageEndpointAccepts(parameters, "background", request.background);
      })
    : response.endpoints;
  const endpoints: ImagePricingEntry[][] = applicable.map((endpoint) =>
    endpoint.pricing.map((entry) => ({
      billable: entry.billable,
      unit: entry.unit,
      costUsd: entry.costUsd,
    })),
  );
  return estimateImageCost({
    endpoints,
    referenceImages,
    model,
    aspectRatio: request?.aspectRatio,
    ...(!request && correlateEndpointCapabilities && operation === "image.generate"
      ? {
          referenceImagesByEndpoint: applicable.map((endpoint) =>
            imageEndpointReferenceMaximum(endpoint.supportedParameters)
          ),
        }
      : {}),
  });
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
  request?: AiCostRequestShape,
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
    resolution: request?.resolution ?? dearestOfferedResolution(entry.supportedResolutions),
    withAudio: request?.generateAudio ?? entry.generateAudio ?? true,
    aspectRatio: request?.aspectRatio,
  });
}

// Concrete submitted fields, separate from the admin's maximum-shape estimate.
// Only public rate cards are cached; estimates are recomputed for every shape.
export type AiCostRequestShape = {
  referenceImages?: number;
  resolution?: string;
  generateAudio?: boolean;
  aspectRatio?: string;
  background?: string;
};

/** A model to price, and who serves it. */
export type AiPricingModelRef = {
  modelId: string;
  provider: string;
};

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
  request,
}: {
  // Who serves a model comes with it. There is no default: a model id alone
  // does not say which provider has it, and guessing produced a "model not
  // found" for models that exist.
  modelsOf: (operation: string) => AiPricingModelRef[];
  now?: Date;
  force?: boolean;
  /** Omit only for the admin's worst-case, model-wide estimate. */
  request?: AiCostRequestShape;
}): Promise<AiCostEstimates> {
  const options = { force, now: now.getTime() };
  const pairs = Object.keys(AI_PRICING_CATALOG).flatMap((operation) => {
    let models: AiPricingModelRef[] = [];
    try {
      models = modelsOf(operation);
    } catch (error) {
      console.warn("[ai-cost] model lookup failed", {
        operation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return models.map((ref) => ({
      operation,
      model: ref.modelId,
      provider: ref.provider,
    }));
  });
  const generationModels = [
    ...new Map(
      pairs
        .filter(({ operation }) => operation === "image.generate" && request === undefined)
        .map((pair) => [
          `${pair.provider} ${pair.model}`,
          { modelId: pair.model, provider: pair.provider },
        ]),
    ).values(),
  ];
  if (force && generationModels.length > 0) {
    clearAiImageModelCapabilitiesCache();
  }
  // A missing capability entry means the public lookup failed or did not know
  // the model. Keep the established fail-open behavior in that case: pricing
  // the service-wide maximum is conservative and does not misreport an outage
  // as proof that the model accepts no references.
  const imageCapabilities = generationModels.length > 0
    ? await loadAiImageModelCapabilities(generationModels, options.now)
    : new Map<string, AiImageModelCapabilities>();

  const entries = await Promise.all(
    pairs.map(async ({ operation, model, provider }): Promise<AiCostEstimateEntry> => {
      try {
        const estimate = await estimateOperation(
          operation,
          model,
          provider,
          imageCapabilities,
          options,
          request,
        );
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

// The Gateway's rate card for one model, cached like OpenRouter's: every
// operation that shares the model shares the fetch.
async function loadGatewayPricing(
  model: string,
  options: { force: boolean; now: number },
): Promise<
  | { ok: true; card: GatewayRateCard }
  | { ok: false; reason: AiCostUnknownReason }
> {
  const outcome = await fetchPricing(
    `gateway-rate-card:${model}`,
    async () => await loadGatewayRateCard(model),
    options,
  );
  return outcome.ok
    ? { ok: true, card: outcome.value as GatewayRateCard }
    : { ok: false, reason: outcome.failure };
}

async function estimateGatewayImageOperation(
  model: string,
  referenceImages: number,
  options: { force: boolean; now: number },
  aspectRatio?: string,
): Promise<AiCostEstimate> {
  // Share one catalog request across all image models and operations.
  const outcome = await fetchPricing(
    "gateway-image-prices",
    async () => await loadGatewayImagePrices(),
    options,
  );
  if (!outcome.ok) return { status: "unknown", reason: outcome.failure };

  const prices = outcome.value as Map<string, GatewayImagePrice | null>;
  if (!prices.has(model)) return { status: "unknown", reason: "model_not_found" };
  const price = prices.get(model);
  if (!price) return { status: "unknown", reason: "price_not_published" };
  return estimateImageCost({
    endpoints: [[{ billable: "output_image", ...price }]],
    referenceImages,
    model,
    aspectRatio,
  });
}

// Video and text rates are published per endpoint; image rates are read from
// the model catalog by estimateGatewayImageOperation instead.
async function estimateGatewayOperation(
  operation: string,
  model: string,
  options: { force: boolean; now: number },
  request?: AiCostRequestShape,
): Promise<AiCostEstimate> {
  const pricing = await loadGatewayPricing(model, options);
  if (!pricing.ok) {
    return { status: "unknown", reason: pricing.reason };
  }

  if (operation.startsWith("video.")) {
    const rate = gatewayDearestVideoRate(pricing.card, {
      // Edit, extension and motion always carry the source clip. Ordinary
      // generation is priced as text/image-to-video; optional reference-video
      // input is not treated as a different billing operation here.
      videoInput: operation !== "video.generate",
      resolution: request?.resolution,
      aspectRatio: request?.aspectRatio,
    });
    if (!rate) {
      return { status: "unknown", reason: "unsupported_pricing_shape" };
    }
    return {
      status: "estimated",
      usdMin: rate.usdPerSecond,
      usdMax: rate.usdPerSecond,
      // Only when the provider tagged the rate. An untagged rate is the one
      // any request pays, and naming the model as the "SKU" would read as a
      // shape that was chosen rather than one that was never offered.
      assumptions: [
        ...(rate.label
          ? [{ kind: "videoSku" as const, value: rate.label }]
          : []),
        ...(rate.tokenCalculation
          ? [
              {
                kind: "videoTokens" as const,
                tokensPerSecond: rate.tokenCalculation.tokensPerSecond,
                resolution: rate.tokenCalculation.resolution,
              },
            ]
          : []),
      ],
    };
  }
  if (operation === "audio.transcribe") {
    return estimateTranscriptionCost({
      model,
      promptPriceUsd: pricing.card.promptUsd ?? 0,
    });
  }
  if (operation === "subtitle.translate") {
    return estimateTranslationCost({
      promptPriceUsd: pricing.card.promptUsd ?? 0,
      completionPriceUsd: pricing.card.completionUsd ?? 0,
    });
  }
  return { status: "unknown", reason: "unsupported_pricing_shape" };
}

async function estimateOperation(
  operation: string,
  model: string,
  provider: string,
  imageCapabilities: ReadonlyMap<string, AiImageModelCapabilities>,
  options: { force: boolean; now: number },
  request?: AiCostRequestShape,
): Promise<AiCostEstimate> {
  if (provider !== DEFAULT_AI_PROVIDER_ID) {
    if (operation.startsWith("image.")) {
      return await estimateGatewayImageOperation(
        model,
        request?.referenceImages ?? (operation === "image.generate"
          ? imageCapabilityOf(imageCapabilities, { modelId: model, provider })
              ?.maxReferenceImages ?? AI_MAX_IMAGE_REFERENCES
          : 1),
        options,
        request?.aspectRatio,
      );
    }
    return await estimateGatewayOperation(operation, model, options, request);
  }
  // Every video operation is metered per second of output and priced off the
  // same rate card, so they resolve together. Matching only video.generate
  // here would send an edit, an extension or a motion job down the text path,
  // where its model is not a model at all and the lookup answers 404.
  if (operation.startsWith("video.")) {
    return await estimateVideoOperation(model, options, request);
  }
  if (operation.startsWith("image.")) {
    // Every edit sends one source image. Only the admin estimate uses the
    // maximum reference set; reservations use the submitted count.
    return await estimateImageOperation(
      model,
      operation,
      request?.referenceImages ?? (operation === "image.generate"
        ? imageCapabilityOf(imageCapabilities, { modelId: model, provider })
            ?.maxReferenceImages ?? AI_MAX_IMAGE_REFERENCES
        : 1),
      request !== undefined || operation !== "image.generate" ||
        imageCapabilityOf(imageCapabilities, { modelId: model, provider }) !==
          undefined,
      options,
      request,
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
