// What the Gateway charges for a model.
//
// Read from GET /v1/models/{author}/{slug}/endpoints, which needs no
// credentials — the same reason the capability list is read unauthenticated:
// the admin console reads it too, and that worker holds no provider key.
//
// The route answers in the same shape OpenRouter's does, down to the field
// names (`endpoints[].pricing` with `prompt`, `completion` and
// `video_duration_pricing`). That is convenient but not a contract: nothing in
// Vercel's documentation describes this response, so every field is optional
// here and an unreadable one costs the estimate, not the page.
//
// Video is the one that differs from OpenRouter in substance. OpenRouter
// publishes a map of named SKUs; the Gateway publishes either per-second rates
// or resolution tiers priced per million generated video tokens. Both are
// normalized to a per-second figure before the admin console sees them.

import { z } from "zod";
import { multiplyDecimalAmounts } from "@beutl/core";
import { videoTokensPerSecond } from "../../cost-estimate";
import { AiProviderError, InvalidAiProviderOutputError } from "../errors";
import { readBoundedJson } from "./bounded";
import { aiVideoResolutionOfGatewayLabel } from "./resolution";

const ENDPOINTS_URL_BASE = "https://ai-gateway.vercel.sh/v1/models";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 8 * 1024 * 1024;

// Numbers arrive as strings ("0.00000012"), but a provider that switches to
// JSON numbers should not read as a missing price.
const moneySchema = z.union([z.string(), z.number()]).nullish();

const videoDurationPricingSchema = z.object({
  resolution: z.string().nullish(),
  cost_per_second: moneySchema,
});

const videoTokenRateSchema = z.object({
  cost_per_million_tokens: moneySchema,
});

const videoTokenTierSchema = z.object({
  resolution: z.string(),
  no_video_input: videoTokenRateSchema.nullish(),
  with_video_input: videoTokenRateSchema.nullish(),
});

const videoTokenPricingSchema = z.object({
  tiers: z.array(z.unknown()).nullish(),
});

const endpointSchema = z.object({
  pricing: z
    .object({
      prompt: moneySchema,
      completion: moneySchema,
      video_duration_pricing: z.array(z.unknown()).nullish(),
      video_token_pricing: z.unknown().nullish(),
    })
    .nullish(),
});

const endpointsResponseSchema = z.object({
  data: z.object({
    endpoints: z.array(z.unknown()).nullish(),
  }),
});

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type GatewayVideoRate = {
  /** The label the provider tagged the rate with, or null for a rate that applies to any shape. */
  label: string | null;
  usdPerSecond: number;
  /** Absent when the rate applies whether or not a source video is sent. */
  videoInput?: boolean;
  /** Present when a token rate was converted to the per-second figure above. */
  tokenCalculation?: {
    tokensPerSecond: number;
    resolution: string;
  };
};

export type GatewayRateCard = {
  /** Every usable video rate normalized to USD per second. */
  videoRates: GatewayVideoRate[];
  /** Per input token, in USD, or null when the model publishes none. */
  promptUsd: number | null;
  /** Per output token, in USD, or null when the model publishes none. */
  completionUsd: number | null;
};

export type GatewayImagePrice = {
  costUsd: number;
  unit: "image" | "token";
};

// GET /v1/models and /endpoints currently publish no price for FLUX 3, while
// Vercel's model page publishes three configurations, and Gateway's pricing
// documentation states that it adds no markup. This service never asks for
// draft mode, so only the exact full-render HD/FHD rates are retained here for
// text/image and source-video requests. Evidence and update rules:
// docs/ai-gateway-video-pricing.md.
const VERIFIED_VIDEO_RATE_FALLBACKS: Readonly<
  Record<string, readonly GatewayVideoRate[]>
> = {
  "bfl/flux-3-video": [
    { label: "hd", usdPerSecond: 0.17, videoInput: false },
    { label: "fhd", usdPerSecond: 0.29, videoInput: false },
    { label: "hd", usdPerSecond: 0.41, videoInput: true },
    { label: "fhd", usdPerSecond: 0.53, videoInput: true },
  ],
};

const imageModelSchema = z.object({
  id: z.string().min(1),
  type: z.string().nullish(),
  pricing: z.record(z.string(), z.unknown()).nullish(),
});

function positiveMoney(value: unknown): number | null {
  const parsed = moneySchema.safeParse(value);
  if (!parsed.success) return null;
  const amount = toNumber(parsed.data);
  return amount !== null && amount > 0 ? amount : null;
}

function imagePriceOf(model: z.infer<typeof imageModelSchema>): GatewayImagePrice | null {
  const pricing = model.pricing;
  if (!pricing) return null;

  const perImage = positiveMoney(pricing.image);
  if (perImage !== null) return { costUsd: perImage, unit: "image" };

  // The adapter does not choose a size or quality. Only an explicit default
  // applies; a price for 4K, vectorization or a particular style does not.
  const variants = pricing.image_dimension_quality_pricing;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (
        typeof variant !== "object" || variant === null ||
        variant.size !== "default" ||
        Object.keys(variant).some((key) => key !== "size" && key !== "cost")
      ) continue;
      const costUsd = positiveMoney(variant.cost);
      if (costUsd !== null) return { costUsd, unit: "image" };
    }
  }

  // Dedicated image models (including GPT Image 2) publish image output
  // tokens here. A language model's output price is for text, so it cannot
  // stand in for a missing image price. The input field is likewise not a
  // separate image-input rate and must not be charged for reference images.
  const perToken = model.type === "image" ? positiveMoney(pricing.output) : null;
  return perToken === null ? null : { costUsd: perToken, unit: "token" };
}

/**
 * Image output prices from the public model catalog. The per-model endpoints
 * route reports zero for image/image_output even for paid image models.
 * Null means the model exists but publishes no usable image price.
 * https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#list-models
 */
export async function loadGatewayImagePrices(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, GatewayImagePrice | null>> {
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINTS_URL_BASE, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new AiProviderError("Vercel AI Gateway image prices failed", { cause });
  }
  if (!response.ok) {
    throw new AiProviderError(
      `Vercel AI Gateway image prices failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(
    await readBoundedJson(response, MAX_CATALOG_RESPONSE_BYTES, "image prices"),
  );
  if (!parsed.success) {
    throw new InvalidAiProviderOutputError("Vercel AI Gateway returned unreadable image prices", {
      cause: parsed.error,
    });
  }
  const prices = new Map<string, GatewayImagePrice | null>();
  for (const raw of parsed.data.data) {
    const model = imageModelSchema.safeParse(raw);
    if (model.success) prices.set(model.data.id, imagePriceOf(model.data));
  }
  return prices;
}


/**
 * The published rates for one model.
 *
 * A model the Gateway does not have answers 404, and the error carries that
 * status so a caller can tell "no such model" from "the provider is down" —
 * the distinction the admin console shows.
 *
 * A model that publishes an unreadable rate for one resolution keeps the rates
 * that did parse: the shape is undocumented, and one new field must not cost
 * the whole estimate.
 */
export async function loadGatewayRateCard(
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayRateCard> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${ENDPOINTS_URL_BASE}/${modelId}/endpoints`,
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      },
    );
  } catch (cause) {
    throw new AiProviderError("Vercel AI Gateway rate card failed", { cause });
  }
  if (!response.ok) {
    throw new AiProviderError(
      `Vercel AI Gateway rate card failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }

  const parsed = endpointsResponseSchema.safeParse(
    await readBoundedJson(response, MAX_RESPONSE_BYTES, "rate card"),
  );
  if (!parsed.success) {
    throw new InvalidAiProviderOutputError(
      "Vercel AI Gateway returned an unreadable rate card",
      { cause: parsed.error },
    );
  }

  const videoRates: GatewayVideoRate[] = [];
  let promptUsd: number | null = null;
  let completionUsd: number | null = null;

  for (const raw of parsed.data.data.endpoints ?? []) {
    const endpoint = endpointSchema.safeParse(raw);
    if (!endpoint.success) continue;
    const pricing = endpoint.data.pricing;
    if (!pricing) continue;

    // Several endpoints can serve one model at different prices. The dearest
    // is what the margin has to hold against, since this service does not pin
    // a request to one of them.
    const prompt = toNumber(pricing.prompt);
    if (prompt !== null && (promptUsd === null || prompt > promptUsd)) {
      promptUsd = prompt;
    }
    const completion = toNumber(pricing.completion);
    if (
      completion !== null &&
      (completionUsd === null || completion > completionUsd)
    ) {
      completionUsd = completion;
    }

    for (const rawRate of pricing.video_duration_pricing ?? []) {
      const rate = videoDurationPricingSchema.safeParse(rawRate);
      if (!rate.success) continue;
      const usdPerSecond = toNumber(rate.data.cost_per_second);
      if (usdPerSecond === null || usdPerSecond <= 0) continue;
      videoRates.push({
        label: rate.data.resolution ?? null,
        usdPerSecond,
      });
    }

    const tokenPricing = videoTokenPricingSchema.safeParse(
      pricing.video_token_pricing,
    );
    if (!tokenPricing.success) continue;
    for (const rawTier of tokenPricing.data.tiers ?? []) {
      const tier = videoTokenTierSchema.safeParse(rawTier);
      if (!tier.success) continue;
      const resolution = aiVideoResolutionOfGatewayLabel(
        tier.data.resolution,
      );
      if (resolution === null) continue;
      const tokensPerSecond = videoTokensPerSecond(resolution);
      if (tokensPerSecond === null) continue;

      for (const [videoInput, rawRate] of [
        [false, tier.data.no_video_input],
        [true, tier.data.with_video_input],
      ] as const) {
        const costPerMillionTokens = toNumber(
          rawRate?.cost_per_million_tokens,
        );
        if (
          costPerMillionTokens === null ||
          costPerMillionTokens <= 0
        ) continue;
        videoRates.push({
          label: tier.data.resolution,
          usdPerSecond: multiplyDecimalAmounts(
            costPerMillionTokens,
            0.000001,
            tokensPerSecond,
          ),
          videoInput,
          tokenCalculation: { tokensPerSecond, resolution },
        });
      }
    }
  }

  if (videoRates.length === 0) {
    videoRates.push(
      ...(VERIFIED_VIDEO_RATE_FALLBACKS[modelId] ?? []).map((rate) => ({
        ...rate,
      })),
    );
  }

  return { videoRates, promptUsd, completionUsd };
}

/**
 * The dearest per-second rate a request this service can build would be
 * charged, and the label it came from.
 *
 * Only rates this service could actually incur count. A rate tagged with a
 * resolution this service never asks for — 768p and 4K are both dropped when a
 * label is folded onto this service's names — would understate nothing but
 * would misreport which shape the figure describes. A rate carrying no
 * resolution always counts: it is either the model's base rate or, as with
 * Kling's `std`/`pro`, a variant this service does not pick between, and the
 * dearer of those is what a request can cost.
 *
 * Null when the model publishes no rate that applies, which is reported as an
 * unknown cost rather than as a free one.
 */
export function gatewayDearestVideoRate(
  rateCard: GatewayRateCard,
  {
    videoInput,
  }: {
    /** Whether this operation always sends a source video. Omit to consider both. */
    videoInput?: boolean;
  } = {},
): GatewayVideoRate | null {
  let best: GatewayVideoRate | null = null;
  for (const rate of rateCard.videoRates) {
    if (
      videoInput !== undefined &&
      rate.videoInput !== undefined &&
      rate.videoInput !== videoInput
    ) {
      continue;
    }
    if (rate.label !== null && aiVideoResolutionOfGatewayLabel(rate.label) === null) {
      continue;
    }
    if (!best || rate.usdPerSecond > best.usdPerSecond) {
      best = rate;
    }
  }
  return best;
}
