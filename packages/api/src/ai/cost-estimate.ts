// Estimating what one chargeable unit of an AI operation costs at the
// provider's published rates.
//
// ADMIN CONSOLE ONLY. These figures exist so an administrator can tell whether
// a unit price covers its cost. They are estimates from a price list, not what
// was actually billed: nothing records the real per-job cost today.
//
// Pure functions with no I/O. ./model-pricing fetches and normalizes the price
// list, then hands it here.
//
// Two rules run through everything below:
//   - A figure is either derived from a price whose unit is known, or it is
//     unknown. Never 0, never NaN. A zero would read as "this is free".
//   - Where an assumption is needed to bridge a price to a chargeable unit, it
//     is returned alongside the number so the UI can state it.

export type AiCostUnknownReason =
  | "provider_unavailable"
  | "model_not_found"
  | "invalid_response"
  | "unsupported_pricing_shape"
  | "unknown_stt_pricing_unit"
  | "zero_price_reported";

export type AiCostAssumption =
  | { kind: "imageOutputTokens"; value: number }
  | { kind: "imageInputTokens"; value: number }
  | { kind: "imageMegapixels"; value: number }
  | { kind: "imageInputNotPriced" }
  | { kind: "transcriptionMinute" }
  | { kind: "translationTokensPerCharacter"; min: number; max: number }
  | { kind: "videoSku"; value: string };

export type AiCostEstimate =
  | {
      status: "estimated";
      // A range because a model can price several providers or variants, and
      // because token density differs by language. Equal bounds render as one
      // number.
      usdMin: number;
      usdMax: number;
      assumptions: AiCostAssumption[];
    }
  | { status: "unknown"; reason: AiCostUnknownReason };

// gpt-image-1 bills its output as tokens; 1024x1024 at medium quality is 1,056
// of them, which reproduces OpenAI's published $0.042 per image.
export const ASSUMED_IMAGE_OUTPUT_TOKENS = 1056;
export const ASSUMED_IMAGE_INPUT_TOKENS = 1056;
// 1024 x 1024 expressed in megapixels, for models that bill by area.
export const ASSUMED_IMAGE_MEGAPIXELS = (1024 * 1024) / 1_000_000;
export const TRANSCRIPTION_SECONDS_PER_UNIT = 60;
export const TRANSLATION_CHARACTERS_PER_UNIT = 1000;
// A CJK character is roughly one token; Latin text runs about four characters
// per token. The gap is wide enough that averaging would be wrong for both, so
// it is carried as the range instead.
export const TRANSLATION_TOKENS_PER_CHARACTER = { min: 0.25, max: 1 } as const;
export const TRANSLATION_OUTPUT_RATIO = 1;

// Speech-to-text prices come back as a bare number whose unit is not in the
// response. The same model is $0.00000333 per second from one provider and
// $0.04 per hour from another, so the magnitude cannot be used to guess.
//
// Only models whose unit was confirmed against the provider's published price
// belong here. Anything absent is reported as unknown rather than estimated
// with a guessed unit — a wrong unit here is off by 60x and would be believed.
export const TRANSCRIPTION_PRICE_UNITS: Record<string, "second" | "minute"> = {
  // DeepInfra publishes $0.0002 per minute, matching $0.00000333 per second.
  "openai/whisper-large-v3-turbo": "second",
};

function unknown(reason: AiCostUnknownReason): AiCostEstimate {
  return { status: "unknown", reason };
}

function estimated(
  usdMin: number,
  usdMax: number,
  assumptions: AiCostAssumption[],
): AiCostEstimate {
  if (
    !Number.isFinite(usdMin) ||
    !Number.isFinite(usdMax) ||
    usdMin <= 0 ||
    usdMax <= 0
  ) {
    return unknown("zero_price_reported");
  }
  return {
    status: "estimated",
    usdMin: Math.min(usdMin, usdMax),
    usdMax: Math.max(usdMin, usdMax),
    assumptions,
  };
}

export type ImagePricingEntry = {
  billable: string;
  unit: string;
  costUsd: number;
};

// One provider endpoint's worth of image pricing. Returns null when the unit is
// one this code does not understand, so the caller can fall back rather than
// treat a missing charge as free.
function estimateImageEndpoint(
  entries: ImagePricingEntry[],
  { referenceImages }: { referenceImages: number },
): { usd: number; assumptions: AiCostAssumption[] } | null {
  const assumptions: AiCostAssumption[] = [];
  const priceOf = (
    billable: string,
    quantity: number,
  ): number | null | undefined => {
    const entry = entries.find((candidate) => candidate.billable === billable);
    if (!entry) return undefined;
    if (!Number.isFinite(entry.costUsd) || entry.costUsd <= 0) return null;
    switch (entry.unit) {
      case "image":
        return entry.costUsd * quantity;
      case "megapixel":
        assumptions.push({
          kind: "imageMegapixels",
          value: ASSUMED_IMAGE_MEGAPIXELS,
        });
        return entry.costUsd * ASSUMED_IMAGE_MEGAPIXELS * quantity;
      case "token": {
        const tokens =
          billable === "output_image"
            ? ASSUMED_IMAGE_OUTPUT_TOKENS
            : ASSUMED_IMAGE_INPUT_TOKENS;
        assumptions.push({
          kind:
            billable === "output_image"
              ? "imageOutputTokens"
              : "imageInputTokens",
          value: tokens,
        });
        return entry.costUsd * tokens * quantity;
      }
      default:
        return null;
    }
  };

  const output = priceOf("output_image", 1);
  // Without an output charge there is nothing to estimate from.
  if (output === undefined || output === null) {
    return null;
  }

  let total = output;
  if (referenceImages > 0) {
    const input = priceOf("input_image", referenceImages);
    if (input === null) {
      return null;
    }
    if (input === undefined) {
      // The endpoint publishes no separate charge for a reference image. That
      // is a claim about the estimate, not a zero: an edit sends one, and the
      // admin setting a price for it has to know it was not counted.
      assumptions.push({ kind: "imageInputNotPriced" });
    } else {
      total += input;
    }
    // Text prompt tokens are left out: they are about 1% of an image request
    // and cannot be sized without knowing the prompt.
  }
  return { usd: total, assumptions };
}

export function estimateImageCost({
  endpoints,
  referenceImages,
}: {
  endpoints: ImagePricingEntry[][];
  referenceImages: number;
}): AiCostEstimate {
  const results = endpoints
    .map((entries) => estimateImageEndpoint(entries, { referenceImages }))
    .filter((result): result is NonNullable<typeof result> => result !== null);
  if (results.length === 0) {
    return unknown("unsupported_pricing_shape");
  }

  const amounts = results.map((result) => result.usd);
  const assumptions = new Map<string, AiCostAssumption>();
  for (const result of results) {
    for (const assumption of result.assumptions) {
      assumptions.set(JSON.stringify(assumption), assumption);
    }
  }
  return estimated(Math.min(...amounts), Math.max(...amounts), [
    ...assumptions.values(),
  ]);
}

export function estimateTranscriptionCost({
  model,
  promptPriceUsd,
}: {
  model: string;
  promptPriceUsd: number;
}): AiCostEstimate {
  const unit = TRANSCRIPTION_PRICE_UNITS[model];
  if (!unit) {
    return unknown("unknown_stt_pricing_unit");
  }
  if (!Number.isFinite(promptPriceUsd) || promptPriceUsd <= 0) {
    return unknown("zero_price_reported");
  }
  const perMinute =
    unit === "second"
      ? promptPriceUsd * TRANSCRIPTION_SECONDS_PER_UNIT
      : promptPriceUsd;
  // Billing rounds up to a whole started minute, so a shorter clip costs the
  // same to the customer but less to serve. This is the ceiling.
  return estimated(perMinute, perMinute, [{ kind: "transcriptionMinute" }]);
}

export function estimateTranslationCost({
  promptPriceUsd,
  completionPriceUsd,
}: {
  promptPriceUsd: number;
  completionPriceUsd: number;
}): AiCostEstimate {
  // Both rates have to be known. loadModelPricing reads a missing completion
  // rate as zero, and translation output is the same size as its input, so
  // accepting a zero here would report roughly half the real cost as a figure
  // the operator sets a price against.
  if (
    !Number.isFinite(promptPriceUsd) ||
    !Number.isFinite(completionPriceUsd) ||
    promptPriceUsd <= 0 ||
    completionPriceUsd <= 0
  ) {
    return unknown("zero_price_reported");
  }
  const costFor = (tokensPerCharacter: number) => {
    const inputTokens = TRANSLATION_CHARACTERS_PER_UNIT * tokensPerCharacter;
    const outputTokens = inputTokens * TRANSLATION_OUTPUT_RATIO;
    return inputTokens * promptPriceUsd + outputTokens * completionPriceUsd;
  };
  // The fixed system prompt and JSON envelope are excluded: they do not scale
  // with the 1,000 characters this unit measures.
  return estimated(
    costFor(TRANSLATION_TOKENS_PER_CHARACTER.min),
    costFor(TRANSLATION_TOKENS_PER_CHARACTER.max),
    [
      {
        kind: "translationTokensPerCharacter",
        min: TRANSLATION_TOKENS_PER_CHARACTER.min,
        max: TRANSLATION_TOKENS_PER_CHARACTER.max,
      },
    ],
  );
}

const VIDEO_SECOND_SKU_PREFIXES = [
  "duration_seconds",
  "text_to_video_duration_seconds",
];
const VIDEO_CENTS_SKU_PREFIXES = [
  "cents_per_second_output",
  "cents_per_video_output_second",
];
// Continuation and video-input SKUs price something this app never requests.
const VIDEO_SKU_EXCLUSIONS = ["continuation", "with_video_input"];

// Video SKU keys vary a lot between models: USD per second, cents per second,
// and opaque token counts all appear, with optional resolution and audio
// suffixes. Resolve to a per-second USD figure or report the shape as unknown.
export function estimateVideoCost({
  pricingSkus,
  resolution,
  withAudio,
}: {
  pricingSkus: Record<string, string>;
  resolution: string;
  withAudio: boolean;
}): AiCostEstimate {
  const candidates = Object.entries(pricingSkus).filter(
    ([key]) =>
      !VIDEO_SKU_EXCLUSIONS.some((excluded) => key.includes(excluded)),
  );
  if (candidates.length === 0) {
    return unknown("unsupported_pricing_shape");
  }

  const audioSuffix = withAudio ? "_with_audio" : "_without_audio";
  const resolutionSuffix = `_${resolution.toLowerCase()}`;

  const scoreOf = (key: string): number | null => {
    const prefix = [
      ...VIDEO_SECOND_SKU_PREFIXES,
      ...VIDEO_CENTS_SKU_PREFIXES,
    ].find((candidate) => key.startsWith(candidate));
    if (!prefix) return null;
    const rest = key.slice(prefix.length);
    // Audio must match when the model distinguishes it at all.
    if (rest.includes("_audio") && !rest.includes(audioSuffix)) return null;
    // Prefer an exact resolution match, then a key with no resolution at all.
    // veo-3.1 has no 720p SKU, so falling back to the base key is required.
    // The resolution is not always the final segment — "_720p_with_audio" puts
    // it in the middle — so the whole key is searched rather than its tail.
    if (rest.includes(resolutionSuffix)) return 2;
    if (/_\d+(k|p)(_|$)/i.test(rest)) return null;
    return 1;
  };

  let best: { key: string; usd: number; score: number } | null = null;
  for (const [key, rawValue] of candidates) {
    const score = scoreOf(key);
    if (score === null) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    const isCents = VIDEO_CENTS_SKU_PREFIXES.some((prefix) =>
      key.startsWith(prefix),
    );
    const usd = isCents ? value / 100 : value;
    // Two SKUs can match equally well — same audio variant, neither naming a
    // resolution — and then the object's key order would decide the figure.
    // Take the dearer one: this estimate exists to check that a price covers
    // its cost, and understating the cost is the direction that misleads.
    if (!best || score > best.score || (score === best.score && usd > best.usd)) {
      best = { key, usd, score };
    }
  }

  if (!best) {
    return unknown("unsupported_pricing_shape");
  }
  return estimated(best.usd, best.usd, [
    { kind: "videoSku", value: best.key },
  ]);
}
