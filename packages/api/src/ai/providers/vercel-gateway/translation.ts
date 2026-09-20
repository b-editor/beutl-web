// Subtitle translation through Vercel AI Gateway.
//
// The prompt, the reply schema and the check that decides whether a reply can
// be stored are shared with OpenRouter's path (../../translation-contract), so
// the two providers are held to the same terms. Only how the request is put on
// the wire differs.
//
// Streaming works the way it already did: the accumulated text is parsed by the
// same brace-counting reader, each finished subtitle is handed to the caller as
// a preview, and the whole text is validated at the end. A preview is never
// what gets stored.

import { streamText, generateText } from "ai";

// Taken from the call rather than imported: @ai-sdk/provider, where the type is
// declared, is not a direct dependency of this package.
type GatewayProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]["providerOptions"]
>;
import { AiProviderError } from "../errors";
import type { AiTranslateRequest, TranslationSegment } from "../types";
import { createTranslationSegmentReader } from "../../translation-stream";
import {
  parseTranslationContent,
  toTranslationPromptSegments,
  translationJsonSchema,
  translationSystemPrompt,
  translationUserMessage,
} from "../../translation-contract";
import { createGatewayClient } from "./config";
import { toGatewayProviderError } from "./errors";

const PROVIDER_LABEL = "Vercel AI Gateway";

function buildRequest(request: AiTranslateRequest) {
  const promptSegments = toTranslationPromptSegments(
    request.segments,
    request.contexts,
  );
  return {
    system: translationSystemPrompt({
      style: request.style,
      hasDurations: promptSegments.some(
        (segment) => "durationSeconds" in segment,
      ),
    }),
    user: translationUserMessage({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      style: request.style,
      segments: promptSegments,
    }),
    // Named ids and a closed object, the same shape OpenRouter is sent. The
    // Gateway carries it as the chat-completions response format.
    responseFormat: {
      type: "json_schema" as const,
      json_schema: {
        name: "subtitle_translation",
        strict: true,
        schema: translationJsonSchema(request.segments),
      },
    },
  };
}

export async function translateGatewaySegments(
  request: AiTranslateRequest,
): Promise<TranslationSegment[]> {
  const { system, user, responseFormat } = buildRequest(request);
  const model = createGatewayClient()(request.model);
  // Cast because the schema is a JSON document the SDK only types as opaque
  // JSON; its shape is checked where it is built, not here.
  const providerOptions = {
    gateway: { responseFormat },
  } as unknown as GatewayProviderOptions;

  if (request.onSegment) {
    return await translateStreaming({
      request,
      model,
      system,
      user,
      providerOptions,
      onSegment: request.onSegment,
    });
  }

  let text: string;
  try {
    ({ text } = await generateText({
      model,
      system,
      prompt: user,
      providerOptions,
      abortSignal: request.signal,
    }));
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway translation request failed",
    );
  }
  return parseTranslationContent(text, request.segments, PROVIDER_LABEL);
}

async function translateStreaming({
  request,
  model,
  system,
  user,
  providerOptions,
  onSegment,
}: {
  request: AiTranslateRequest;
  model: ReturnType<ReturnType<typeof createGatewayClient>>;
  system: string;
  user: string;
  providerOptions: GatewayProviderOptions;
  onSegment: (segment: TranslationSegment) => void;
}): Promise<TranslationSegment[]> {
  const reader = createTranslationSegmentReader();
  const wanted = new Set(request.segments.map((segment) => segment.id));
  const seen = new Set<string>();
  let content = "";

  try {
    const result = streamText({
      model,
      system,
      prompt: user,
      providerOptions,
      abortSignal: request.signal,
    });
    for await (const delta of result.textStream) {
      content += delta;
      for (const segment of reader.push(delta)) {
        // A preview for a subtitle nobody asked about, or a second one for the
        // same subtitle, is noise the screen must not act on.
        if (!wanted.has(segment.id) || seen.has(segment.id)) continue;
        seen.add(segment.id);
        onSegment(segment);
      }
    }
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway translation request failed",
    );
  }

  if (content.length === 0) {
    throw new AiProviderError(
      "Vercel AI Gateway answered a streamed translation with nothing",
    );
  }
  // The previews were shown early; this is what is accepted.
  return parseTranslationContent(content, request.segments, PROVIDER_LABEL);
}
