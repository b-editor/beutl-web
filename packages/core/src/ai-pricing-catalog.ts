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
export const AI_PRICING_CATALOG = {
  "image.generate": { unit: "request" },
  "image.edit.remove_background": { unit: "request" },
  "image.edit.upscale": { unit: "request" },
  "image.edit.restyle": { unit: "request" },
  "image.edit.remove_object": { unit: "request" },
  "image.edit.outpaint": { unit: "request" },
  "audio.transcribe": { unit: "started_minute" },
  "subtitle.translate": { unit: "started_1000_characters" },
  "video.generate": { unit: "second" },
} as const;

export type AiBillingUnit =
  (typeof AI_PRICING_CATALOG)[keyof typeof AI_PRICING_CATALOG]["unit"];

export function aiBillingUnitOf(operation: string): AiBillingUnit | null {
  if (!Object.hasOwn(AI_PRICING_CATALOG, operation)) {
    return null;
  }
  return AI_PRICING_CATALOG[operation as keyof typeof AI_PRICING_CATALOG].unit;
}
