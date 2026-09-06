import { MIN_AI_VIDEO_DURATION_SECONDS } from "./ai-capabilities";

// The billable operations and the input unit each one is metered by.
//
// Unit prices are NOT defined here: they are administrator-configurable and
// resolved through @beutl/api, with the built-in defaults in ./ai-settings.
// This catalog only enumerates which operations exist and how their input is
// measured, so a price lookup always has a known operation.
//
// It lives in @beutl/core rather than @beutl/api because the admin console
// derives what an allowance buys from these units, and @beutl/api pulls in
// @beutl/db, which cannot be imported from a browser bundle.
// `minimumQuantity` is how many billing units the smallest request an entry
// point will accept actually costs. It is one for everything metered by a
// started minute, a started thousand characters, or a valid one-second video;
// whether an operation can be started is decided against this, not against a
// unit nobody can buy.
export const AI_PRICING_CATALOG = {
  "image.generate": { unit: "request", minimumQuantity: 1 },
  "image.edit.remove_background": { unit: "request", minimumQuantity: 1 },
  "image.edit.upscale": { unit: "request", minimumQuantity: 1 },
  "image.edit.restyle": { unit: "request", minimumQuantity: 1 },
  "image.edit.remove_object": { unit: "request", minimumQuantity: 1 },
  "image.edit.outpaint": { unit: "request", minimumQuantity: 1 },
  "audio.transcribe": { unit: "started_minute", minimumQuantity: 1 },
  "subtitle.translate": { unit: "started_1000_characters", minimumQuantity: 1 },
  "video.generate": {
    unit: "second",
    minimumQuantity: MIN_AI_VIDEO_DURATION_SECONDS,
  },
} as const;

export type AiBillingUnit =
  (typeof AI_PRICING_CATALOG)[keyof typeof AI_PRICING_CATALOG]["unit"];

export function aiBillingUnitOf(operation: string): AiBillingUnit | null {
  if (!Object.hasOwn(AI_PRICING_CATALOG, operation)) {
    return null;
  }
  return AI_PRICING_CATALOG[operation as keyof typeof AI_PRICING_CATALOG].unit;
}

export function aiMinimumQuantityOf(operation: string): number | null {
  if (!Object.hasOwn(AI_PRICING_CATALOG, operation)) {
    return null;
  }
  return AI_PRICING_CATALOG[operation as keyof typeof AI_PRICING_CATALOG]
    .minimumQuantity;
}

// The smallest charge an operation can incur. Comparing a unit price against an
// allowance answers the wrong question for anything whose smallest request is
// more than one unit: a four-second video priced under the allowance can still
// be unaffordable at the shortest length the entry point accepts.
export function aiMinimumChargeOf(
  operation: string,
  price: number,
): number | null {
  const minimumQuantity = aiMinimumQuantityOf(operation);
  return minimumQuantity === null ? null : price * minimumQuantity;
}
