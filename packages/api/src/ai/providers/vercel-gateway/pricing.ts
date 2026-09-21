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
// publishes a map of named SKUs; the Gateway publishes a list of per-second
// rates tagged either by resolution or, for Kling, by a `mode` this service
// does not choose.

import { z } from "zod";
import { AiProviderError } from "../errors";
import { readBoundedJson } from "./bounded";
import { aiVideoResolutionOfGatewayLabel } from "./resolution";

const ENDPOINTS_URL_BASE = "https://ai-gateway.vercel.sh/v1/models";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Numbers arrive as strings ("0.00000012"), but a provider that switches to
// JSON numbers should not read as a missing price.
const moneySchema = z.union([z.string(), z.number()]).nullish();

const videoDurationPricingSchema = z.object({
  resolution: z.string().nullish(),
  cost_per_second: moneySchema,
});

const endpointSchema = z.object({
  pricing: z
    .object({
      prompt: moneySchema,
      completion: moneySchema,
      video_duration_pricing: z.array(z.unknown()).nullish(),
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
};

export type GatewayRateCard = {
  /** Every per-second video rate published, in the order the provider listed them. */
  videoRates: GatewayVideoRate[];
  /** Per input token, in USD, or null when the model publishes none. */
  promptUsd: number | null;
  /** Per output token, in USD, or null when the model publishes none. */
  completionUsd: number | null;
};


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
    throw new AiProviderError(
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
): GatewayVideoRate | null {
  let best: GatewayVideoRate | null = null;
  for (const rate of rateCard.videoRates) {
    if (rate.label !== null && aiVideoResolutionOfGatewayLabel(rate.label) === null) {
      continue;
    }
    if (!best || rate.usdPerSecond > best.usdPerSecond) {
      best = rate;
    }
  }
  return best;
}
