import type { AiImageAspectRatio } from "@beutl/core";

// GPT Image 2 takes an explicit size, not the AI SDK's aspectRatio field.
// Keep generation and the token-cost estimate on the same output geometry.
// Both edges must be multiples of 16; the short edge is approximately 1K.
// https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models
export const GPT_IMAGE_2_GEOMETRY: Readonly<Record<AiImageAspectRatio, readonly [number, number]>> = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [2048, 1152],
  "9:16": [1152, 2048],
  "4:3": [1408, 1056],
  "3:4": [1056, 1408],
};

export function isGptImage2Model(model: string | undefined): boolean {
  return model === "openai/gpt-image-2" || model === "openai/gpt-image-2-2026-04-21";
}

export function gptImage2OutputSize(aspectRatio: AiImageAspectRatio): `${number}x${number}` {
  const [width, height] = GPT_IMAGE_2_GEOMETRY[aspectRatio];
  return `${width}x${height}`;
}
