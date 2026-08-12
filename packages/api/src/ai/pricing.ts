// The billable operations and the input unit each one is metered by.
//
// Unit prices are NOT defined here: they are administrator-configurable and
// resolved through ./settings (database → environment → built-in default in
// @beutl/core). This catalog only enumerates which operations exist and how
// their input is measured, so a price lookup always has a known operation.
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

export const PRO_PLAN = {
  id: "pro",
  monthlyUsageLimit: 500,
} as const;

export const AI_TOP_UP = {
  credits: 500,
} as const;
