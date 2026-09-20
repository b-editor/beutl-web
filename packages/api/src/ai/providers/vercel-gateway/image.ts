// Image generation and editing through Vercel AI Gateway.
//
// The Gateway has no named operation for background removal, upscaling or
// outpainting — searching its documentation and the whole @ai-sdk/gateway dist
// for those words returns nothing. OpenRouter serves them through provider
// parameters (`background: "transparent"`, `resolution: "4K"`) that have no
// counterpart here, so those three operations are declared unsupported rather
// than approximated with a prompt that would quietly return something else.
// See `supports` in ../vercel-gateway/index.ts.
//
// What is here is the one surface the SDK offers: a prompt, optionally carrying
// source images. `generateImage` with a plain string generates; the same call
// with `{ images, text }` edits, which is what restyle and object removal are.
//
// There is no partial-image stream. The SDK's image API answers in one piece,
// so a caller's `onPartialImage` is simply never invoked and the screen shows
// the finished picture instead of previews.

import { generateImage } from "ai";
import { AI_MAX_IMAGE_REFERENCES } from "@beutl/core";
import { AiProviderError } from "../errors";
import type {
  AiImageEditRequest,
  AiImageGenerateRequest,
  GeneratedImage,
} from "../types";
import { createGatewayClient } from "./config";
import { toGatewayProviderError } from "./errors";

function toGeneratedImage(image: {
  base64: string;
  mediaType: string;
}): GeneratedImage {
  if (!image.base64) {
    throw new AiProviderError("Vercel AI Gateway returned an empty image");
  }
  return { b64Json: image.base64, mediaType: image.mediaType };
}

export async function generateGatewayImage(
  request: AiImageGenerateRequest,
): Promise<GeneratedImage> {
  if (
    request.referenceImages &&
    request.referenceImages.length > AI_MAX_IMAGE_REFERENCES
  ) {
    throw new AiProviderError("Too many reference images");
  }

  // `background` has no top-level field here. Asking for a transparent one is
  // refused by the capability check before this is reached, and "auto" means
  // sending nothing — which is what happens either way.
  try {
    const result = await generateImage({
      model: createGatewayClient().imageModel(request.model),
      prompt:
        request.referenceImages && request.referenceImages.length > 0
          ? {
              images: request.referenceImages.map(
                (reference) => new Uint8Array(reference.bytes),
              ),
              text: request.prompt,
            }
          : request.prompt,
      aspectRatio: request.aspectRatio,
      n: 1,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      abortSignal: request.signal,
    });
    return toGeneratedImage(result.image);
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway image generation failed",
    );
  }
}

export async function editGatewayImage(
  request: AiImageEditRequest,
): Promise<GeneratedImage> {
  // Every edit the Gateway can serve is prompt-driven, so one is required. The
  // operations OpenRouter serves without a prompt — background removal and
  // upscaling — are the ones declared unsupported.
  const prompt = request.prompt?.trim();
  if (!prompt) {
    throw new AiProviderError(`A prompt is required for ${request.task}`);
  }

  try {
    const result = await generateImage({
      model: createGatewayClient().imageModel(request.model),
      prompt: {
        images: [new Uint8Array(request.image)],
        text: prompt,
      },
      n: 1,
      abortSignal: request.signal,
    });
    return toGeneratedImage(result.image);
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway image editing failed",
    );
  }
}
