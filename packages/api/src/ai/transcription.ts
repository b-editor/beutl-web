import { getAiJobResultFile } from "@beutl/db";
import { validateTranscriptionResult } from "./audio-validation";
import { createReservedAiJob, failAiJobAndRefundUsage } from "./credits";
import { AI_JOB_FAILURE_MESSAGES, aiJobFailureMessage, reportAiProviderFailure } from "./job-errors";
import type { AiModelCatalog } from "./model-catalog";
import { AiProviderError } from "./providers/errors";
import { transcriptionProviderFor } from "./providers/registry";
import type { AiTranscribeRequest } from "./providers/types";
import type { AiRequestIdentity } from "./request-integrity";
import { readAiJsonResult, saveAiJsonResult } from "./storage";

export async function recoverTranscription({ jobId, userId, durationSeconds }: {
  jobId: string;
  userId: string;
  durationSeconds: number;
}) {
  const file = await getAiJobResultFile({ jobId, userId });
  if (!file) return null;
  try {
    const stored = validateTranscriptionResult(
      await readAiJsonResult({ objectKey: file.objectKey }) as {
        segments?: unknown; language?: unknown; words?: unknown;
      },
      durationSeconds,
    );
    return {
      segments: stored.segments,
      ...(stored.language ? { language: stored.language } : {}),
      ...(stored.words ? { words: stored.words } : {}),
    };
  } catch (error) {
    console.error("Failed to recover AI transcription result", error);
    return null;
  }
}

export async function prepareTranscription({ userId, model, identity, input }: {
  userId: string;
  model: ReturnType<AiModelCatalog["resolve"]>;
  identity: AiRequestIdentity;
  input: Omit<AiTranscribeRequest, "model" | "signal">;
}) {
  if (!model) {
    return { ok: false as const, errorCode: "aiModelUnavailable" as const, status: 400 as const };
  }
  const { filename, durationSeconds, language } = input;
  const reservation = await createReservedAiJob({
    userId, kind: "stt", provider: model.provider, status: "running",
    inputParams: { filename, durationSeconds, ...(language ? { language } : {}) },
    usagePercent: model.usagePercent, model: model.modelId, ...identity,
  });
  if (!reservation.ok || reservation.outcome === "existing") return reservation;
  const { job } = reservation;
  return {
    ...reservation,
    async execute(options: Pick<AiTranscribeRequest, "signal"> = {}) {
      try {
        const result = await transcriptionProviderFor(model.provider).transcribe({
          ...input, model: model.modelId, ...options,
        });
        const transcript = {
          segments: result.segments,
          ...(result.language ? { language: result.language } : {}),
          ...(result.words ? { words: result.words } : {}),
        };
        await saveAiJsonResult({
          jobId: job.id, userId, filename: `transcription-${job.id}.json`,
          providerCostUsd: result.providerCostUsd,
          result: { version: 1, kind: "stt", ...transcript },
        });
        return { ok: true as const, transcript };
      } catch (error) {
        await failAiJobAndRefundUsage({
          userId, aiJobId: job.id,
          error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.transcription),
        });
        if (error instanceof AiProviderError) {
          reportAiProviderFailure({
            operation: "audio.transcribe", jobId: job.id,
            provider: model.provider, model: model.modelId, error,
          });
        }
        return { ok: false as const, error };
      }
    },
  };
}
