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

import { streamText, generateText, jsonSchema, Output } from "ai";
import { AiProviderError } from "../errors";
import type {
  AiTranslateRequest,
  AiTranslationResult,
  TranslationSegment,
} from "../types";
import { createTranslationSegmentReader } from "../../translation-stream";
import {
  parseTranslationContent,
  toTranslationPromptSegments,
  translationJsonSchema,
  translationSystemPrompt,
  translationUserMessage,
} from "../../translation-contract";
import {
  createGatewayClient,
  gatewayRequestSignal,
} from "./config";
import { toGatewayProviderError } from "./errors";
import {
  gatewayProviderCostUsd,
  withProviderCost,
  type ProviderCostUsd,
} from "../../provider-cost";

const PROVIDER_LABEL = "Vercel AI Gateway";

function assertTranslationFinished(reason: string): void {
  if (reason !== "stop") {
    throw new AiProviderError(`${PROVIDER_LABEL} did not finish the translation (${reason})`);
  }
}

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
    // The Gateway SDK uses the language-model protocol. Structured output
    // belongs in `output`, which the SDK serializes as responseFormat;
    // providerOptions.gateway.responseFormat does not configure it.
    output: Output.object({
      name: "subtitle_translation",
      schema: jsonSchema(translationJsonSchema(request.segments)),
    }),
  };
}

export async function translateGatewaySegments(
  request: AiTranslateRequest,
): Promise<AiTranslationResult> {
  const { system, user, output } = buildRequest(request);
  const model = createGatewayClient()(request.model);

  if (request.onSegment) {
    return await translateStreaming({
      request,
      model,
      system,
      user,
      output,
      onSegment: request.onSegment,
    });
  }

  let text: string;
  let cost: ProviderCostUsd | undefined;
  try {
    const result = await generateText({
      model,
      system,
      prompt: user,
      output,
      abortSignal: gatewayRequestSignal(request.signal),
    });
    assertTranslationFinished(result.finishReason);
    text = result.text;
    cost = gatewayProviderCostUsd(result.finalStep.providerMetadata);
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway translation request failed",
    );
  }
  return withProviderCost(
    parseTranslationContent(text, request.segments, PROVIDER_LABEL),
    cost,
  );
}

async function translateStreaming({
  request,
  model,
  system,
  user,
  output,
  onSegment,
}: {
  request: AiTranslateRequest;
  model: ReturnType<ReturnType<typeof createGatewayClient>>;
  system: string;
  user: string;
  output: ReturnType<typeof buildRequest>["output"];
  onSegment: (segment: TranslationSegment) => void;
}): Promise<AiTranslationResult> {
  const reader = createTranslationSegmentReader();
  const wanted = new Set(request.segments.map((segment) => segment.id));
  const seen = new Set<string>();
  let content = "";
  let finished = false;
  let cost: ProviderCostUsd | undefined;

  try {
    const result = streamText({
      model,
      system,
      prompt: user,
      output,
      abortSignal: gatewayRequestSignal(request.signal),
    });
    // textStream omits error/abort parts. Valid-looking JSON is not proof
    // that the provider completed the request successfully.
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        throw new AiProviderError(`${PROVIDER_LABEL} translation stream failed`, { cause: part.error });
      }
      if (part.type === "abort") {
        throw new AiProviderError(`${PROVIDER_LABEL} translation stream was aborted`);
      }
      if (part.type === "finish") {
        assertTranslationFinished(part.finishReason);
        finished = true;
      }
      if (part.type !== "text-delta") continue;
      const delta = part.text;
      content += delta;
      for (const segment of reader.push(delta)) {
        // A preview for a subtitle nobody asked about, or a second one for the
        // same subtitle, is noise the screen must not act on.
        if (!wanted.has(segment.id) || seen.has(segment.id)) continue;
        seen.add(segment.id);
        onSegment(segment);
      }
    }
    cost = gatewayProviderCostUsd(await result.providerMetadata);
  } catch (cause) {
    throw toGatewayProviderError(
      cause,
      "Vercel AI Gateway translation request failed",
    );
  }

  if (!finished || content.length === 0) {
    throw new AiProviderError(
      "Vercel AI Gateway returned an incomplete translation stream",
    );
  }
  // The previews were shown early; this is what is accepted.
  return withProviderCost(
    parseTranslationContent(content, request.segments, PROVIDER_LABEL),
    cost,
  );
}
