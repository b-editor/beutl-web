// Speech to text through Vercel AI Gateway.
//
// Two differences from OpenRouter's, both visible to the caller:
//
//  - Word-level timestamps are not a field on the SDK's result. They can be
//    asked for through a provider-specific option and come back untyped in
//    `providerMetadata`, which is not something a stored result can rely on.
//    `words` is optional in what this service saves and the capabilities
//    endpoint already says timestamps arrive "when the model supplies them", so
//    a Gateway transcription simply has segments and no words.
//  - There is no documented input language hint. The model detects it, and the
//    detected language is what comes back.
//
// Speech to text is also still rolling out on the Gateway: a team without it
// enabled sees no transcription models, which surfaces here as the model being
// unknown rather than as a silent empty result.

import { experimental_transcribe as transcribe } from "ai";
import { AiProviderError } from "../errors";
import type { AiTranscribeRequest } from "../types";
import {
  InvalidTranscriptionResultError,
  validateTranscriptionResult,
  type TranscriptionResult,
} from "../../audio-validation";
import {
  createGatewayClient,
  gatewayRequestSignal,
} from "./config";
import { toGatewayProviderError } from "./errors";

export async function transcribeGatewayAudio(
  request: AiTranscribeRequest,
): Promise<TranscriptionResult> {
  let result: Awaited<ReturnType<typeof transcribe>>;
  try {
    result = await transcribe({
      model: createGatewayClient().transcriptionModel(request.model),
      audio: new Uint8Array(request.audio),
      abortSignal: gatewayRequestSignal(request.signal),
    });
  } catch (cause) {
    throw toGatewayProviderError(cause, "Vercel AI Gateway transcription failed");
  }

  const segments = result.segments.map((segment) => ({
    start: segment.startSecond,
    end: segment.endSecond,
    text: segment.text,
  }));

  try {
    // The same validation OpenRouter's result goes through: a transcript whose
    // timings fall outside the audio it was given is not a transcript of it.
    return validateTranscriptionResult(
      {
        segments,
        ...(result.language ? { language: result.language } : {}),
      },
      request.durationSeconds,
    );
  } catch (cause) {
    if (cause instanceof InvalidTranscriptionResultError) {
      throw new AiProviderError(
        `Vercel AI Gateway returned invalid transcription data: ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }
}
