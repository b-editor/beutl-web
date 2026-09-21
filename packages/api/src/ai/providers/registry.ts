// Which implementation serves a given provider id.
//
// Every place that used to call OpenRouter directly now asks here. A job row,
// a cleanup row and a catalog entry all carry a provider string, and this is
// the one function that turns that string into something callable — so an
// unknown provider fails in one place with one message instead of at whichever
// call site happened to be reached first.

import { AiProviderError } from "./errors";
import { openRouterProvider } from "./openrouter";
import { vercelGatewayProvider } from "./vercel-gateway";
import { isAiProviderId, type AiProvider, type AiProviderId } from "./types";
import type {
  AiImageProvider,
  AiTranscriptionProvider,
  AiTranslationProvider,
  AiVideoProvider,
} from "./types";

// Partial because an id can be known before its implementation lands.
const PROVIDERS: Partial<Record<AiProviderId, AiProvider>> = {
  openrouter: openRouterProvider,
  "vercel-gateway": vercelGatewayProvider,
};

/** The provider every row written before the column existed belongs to. */
export const DEFAULT_AI_PROVIDER_ID: AiProviderId = "openrouter";

export function listAiProviders(): AiProvider[] {
  return Object.values(PROVIDERS).filter((provider) => provider !== undefined);
}

/** Null when the id is unknown or has no implementation yet. */
export function findAiProvider(id: string): AiProvider | null {
  if (!isAiProviderId(id)) return null;
  return PROVIDERS[id] ?? null;
}

/**
 * Whether a deployment holds the credentials this provider needs.
 *
 * An unknown id answers false: nothing can call it, which is the same
 * situation for every caller as a provider whose key is absent.
 */
export function isAiProviderConfigured(id: string): boolean {
  return findAiProvider(id)?.isConfigured() ?? false;
}

export function providerFor(id: string): AiProvider {
  const provider = findAiProvider(id);
  if (!provider) {
    throw new AiProviderError(`Unsupported AI provider: ${id}`);
  }
  return provider;
}

/**
 * The video half of a provider.
 *
 * Separate from `providerFor` because a provider may serve text and refuse
 * video, and a caller holding a video job needs that refused loudly rather
 * than as an undefined it forgot to check.
 */
export function videoProviderFor(id: string): AiVideoProvider {
  const provider = providerFor(id);
  if (!provider.video) {
    throw new AiProviderError(`AI provider ${id} does not generate video`);
  }
  return provider.video;
}

/**
 * The image half of a provider.
 *
 * Note this says nothing about which edit tasks or models it serves: a provider
 * can hold an image surface while a particular model still refuses transparent
 * output. `supports` answers the operation-level question; image capabilities
 * answer the model-level one.
 */
export function imageProviderFor(id: string): AiImageProvider {
  const provider = providerFor(id);
  if (!provider.image) {
    throw new AiProviderError(`AI provider ${id} does not generate images`);
  }
  return provider.image;
}

export function transcriptionProviderFor(id: string): AiTranscriptionProvider {
  const provider = providerFor(id);
  if (!provider.transcription) {
    throw new AiProviderError(`AI provider ${id} does not transcribe audio`);
  }
  return provider.transcription;
}

export function translationProviderFor(id: string): AiTranslationProvider {
  const provider = providerFor(id);
  if (!provider.translation) {
    throw new AiProviderError(`AI provider ${id} does not translate text`);
  }
  return provider.translation;
}

/** Whether a provider exists and can run the operation. */
export function providerSupportsOperation(
  id: string,
  operation: string,
): boolean {
  return findAiProvider(id)?.supports(operation) ?? false;
}
