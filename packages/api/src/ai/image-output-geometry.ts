import type { AiImageAspectRatio } from "@beutl/core";

// Some image models take an explicit size, not the AI SDK's aspectRatio field.
// Keep generation and the token-cost estimate on the same output geometry.
// Both edges must be multiples of 16; the short edge is approximately 1K.
// https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models
export const EXPLICIT_1K_IMAGE_GEOMETRY: Readonly<Record<AiImageAspectRatio, readonly [number, number]>> = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [2048, 1152],
  "9:16": [1152, 2048],
  "4:3": [1408, 1056],
  "3:4": [1056, 1408],
};

export function explicit1kOutputSize(aspectRatio: AiImageAspectRatio): `${number}x${number}` {
  const [width, height] = EXPLICIT_1K_IMAGE_GEOMETRY[aspectRatio];
  return `${width}x${height}`;
}
