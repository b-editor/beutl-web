// Turning a resolution label into the pixel size the Gateway's API wants.
//
// The two halves of the Gateway disagree about how a resolution is spelled.
// `/v1/models` publishes labels and nothing else — the union across all 35
// video models is 480p, 720p, 768p, 1080p, 2k, 4k, fhd, hd. The generation API
// takes only `{width}x{height}`: the AI SDK types `resolution` as
// `` `${number}x${number}` ``, so a label there is a compile error, and both
// ai-sdk.dev pages use pixel sizes throughout. (Vercel's own Veo docs
// contradict themselves, listing labels in the parameter table and pixel sizes
// in the example directly under it.)
//
// So labels are what a model's capabilities are matched against, and this is
// what a request is actually sent with.

import type { AiVideoAspectRatio, AiVideoResolution } from "@beutl/core";

// The short side each label names. This is the whole of the convention: 720p is
// 1280x720 lying down and 720x1280 standing up.
const SHORT_SIDE_PIXELS: Record<AiVideoResolution, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "2K": 1440,
};

const ASPECT_RATIOS: Record<AiVideoAspectRatio, { width: number; height: number }> = {
  "16:9": { width: 16, height: 9 },
  "9:16": { width: 9, height: 16 },
  "4:3": { width: 4, height: 3 },
  "3:4": { width: 3, height: 4 },
  "1:1": { width: 1, height: 1 },
};

// Encoders want even dimensions, and rounding to even is also what reproduces
// every size Vercel documents: 480 x 16/9 is 853.33, which lands on 854.
function toEven(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * The `{width}x{height}` a request carries, or null when the pair is not one
 * this service offers.
 *
 * Null rather than a guess: a size the model refuses is a request the user is
 * told nothing useful about, and the caller can fall back to sending no
 * resolution at all and letting the model pick.
 */
export function gatewayVideoResolution(
  resolution: string,
  aspectRatio: string | undefined,
): `${number}x${number}` | null {
  const shortSide = SHORT_SIDE_PIXELS[resolution as AiVideoResolution];
  if (shortSide === undefined) return null;
  // A request naming no shape is squared off against 16:9, the one every model
  // in the catalog supports and the one an estimate is priced against.
  const ratio = ASPECT_RATIOS[(aspectRatio ?? "16:9") as AiVideoAspectRatio];
  if (ratio === undefined) return null;

  const longSide = toEven((shortSide * Math.max(ratio.width, ratio.height)) /
    Math.min(ratio.width, ratio.height));
  return ratio.width >= ratio.height
    ? `${longSide}x${shortSide}`
    : `${shortSide}x${longSide}`;
}

// What the provider calls the labels this service knows. `/v1/models` spells
// 2K as "2k" and also offers "hd"/"fhd" for sizes already named by a number,
// so a model's published list is folded onto this service's names before the
// two are compared.
const LABEL_ALIASES: Record<string, AiVideoResolution> = {
  "480p": "480p",
  "720p": "720p",
  hd: "720p",
  "1080p": "1080p",
  fhd: "1080p",
  "2k": "2K",
};

/**
 * This service's name for a resolution the provider published, or null for one
 * it does not offer at all (768p, 4K).
 *
 * 4K is deliberately absent: the cost estimate an administrator prices against
 * assumes the largest shape a model offers at 16:9, and four times the pixels
 * of 1080p would be billed at a price set against something cheaper.
 */
export function aiVideoResolutionOfGatewayLabel(
  label: string,
): AiVideoResolution | null {
  return LABEL_ALIASES[label.toLowerCase()] ?? null;
}
