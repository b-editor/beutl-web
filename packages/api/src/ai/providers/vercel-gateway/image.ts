// Image generation and editing through Vercel AI Gateway.
//
// Prompt-driven edits cover restyling, object removal and outpainting. The web
// client prepares outpainting as a larger transparent canvas before it reaches
// this adapter. Background removal uses the same image-edit request plus
// OpenAI's transparent PNG provider options. Upscaling is the remaining edit
// without an equivalent here; see `supports` in ../vercel-gateway/index.ts.
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
import {
  createGatewayClient,
  gatewayRequestSignal,
} from "./config";
import { toGatewayProviderError } from "./errors";
import { gatewayProviderCostUsd } from "../../provider-cost";
import { explicit1kOutputSize } from "../../image-output-geometry";

function toGeneratedImage(image: {
  base64: string;
  mediaType: string;
}, providerMetadata?: unknown): GeneratedImage {
  if (!image.base64) {
    throw new AiProviderError("Vercel AI Gateway returned an empty image");
  }
  const cost = gatewayProviderCostUsd(providerMetadata);
  return {
    b64Json: image.base64,
    mediaType: image.mediaType,
    ...(cost === undefined ? {} : { providerCostUsd: cost }),
  };
}

// OpenAI requires a transparency-capable format whenever transparent output is
// requested. AI Gateway passes these provider-specific options through under
// the actual provider name.
const OPENAI_TRANSPARENT_PNG_OPTIONS = {
  openai: {
    background: "transparent",
    outputFormat: "png",
  },
} as const;

export async function generateGatewayImage(
  request: AiImageGenerateRequest,
): Promise<GeneratedImage> {
  if (
    request.referenceImages &&
    request.referenceImages.length > AI_MAX_IMAGE_REFERENCES
  ) {
    throw new AiProviderError("Too many reference images");
  }

  // `background` is an OpenAI provider option rather than a top-level AI SDK
  // field. "auto" means sending nothing; capability validation prevents this
  // branch from being used with a model not verified for transparent output.
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
      ...(request.imageSizeMode === "explicit_1k"
        ? { size: explicit1kOutputSize(request.aspectRatio) }
        : { aspectRatio: request.aspectRatio }),
      n: 1,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.background === "transparent"
        ? { providerOptions: OPENAI_TRANSPARENT_PNG_OPTIONS }
        : {}),
      abortSignal: gatewayRequestSignal(request.signal),
    });
    return toGeneratedImage(result.image, result.providerMetadata);
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
  // The screen does not ask users for text when removing a background, but the
  // Gateway edit surface is prompt-driven. Supply the operation's instruction
  // here so the web action, v3 endpoint and retries all send the same request.
  const prompt = request.task === "remove_background"
    ? "Extract the foreground subject from the input image, preserve it exactly, and place it on a fully transparent background."
    : request.prompt?.trim();
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
      // AI Gateway forwards options under the actual provider name. OpenAI
      // requires PNG or WebP when a transparent background is requested.
      ...(request.task === "remove_background"
        ? {
            providerOptions: OPENAI_TRANSPARENT_PNG_OPTIONS,
          }
        : {}),
      abortSignal: gatewayRequestSignal(request.signal),
    });
    return toGeneratedImage(result.image, result.providerMetadata);
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway image editing failed",
    );
  }
}
