import { createReservedAiJob, failAiJobAndRefundUsage } from "./credits";
import { AI_JOB_FAILURE_MESSAGES, aiJobFailureMessage, reportAiProviderFailure } from "./job-errors";
import type { AiModelCatalog } from "./model-catalog";
import { AiProviderError } from "./providers/errors";
import { translationProviderFor } from "./providers/registry";
import type { AiTranslateRequest, TranslationSegmentContext } from "./providers/types";
import type { AiRequestIdentity } from "./request-integrity";
import { saveAiJsonResult } from "./storage";
import { translationCharacterCount } from "./subtitle-validation";

type TranslationInput = Pick<AiTranslateRequest, "sourceLanguage" | "targetLanguage" | "segments" | "style"> & {
  contexts?: Record<string, TranslationSegmentContext & { groupId?: string; partIndex?: number }>;
};

export async function prepareTranslation({ userId, model, identity, input }: {
  userId: string;
  model: ReturnType<AiModelCatalog["resolve"]>;
  identity: AiRequestIdentity;
  input: TranslationInput;
}) {
  if (!model) {
    return { ok: false as const, errorCode: "aiModelUnavailable" as const, status: 400 as const };
  }
  const { sourceLanguage, targetLanguage, segments, style, contexts = {} } = input;
  const reservation = await createReservedAiJob({
    userId, kind: "translation", provider: model.provider, status: "running",
    inputParams: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage, segmentCount: segments.length,
      characterCount: translationCharacterCount({ segments, style }),
    },
    usagePercent: model.usagePercent, model: model.modelId, ...identity,
  });
  if (!reservation.ok || reservation.outcome === "existing") return reservation;
  const { job } = reservation;

  // Reserve before starting SSE; the execution retains the quoted input/model.
  return {
    ...reservation,
    async execute(options: Pick<AiTranslateRequest, "signal" | "onSegment"> = {}) {
      try {
        // Grouping belongs to the stored subtitle. Providers need only timing.
        const providerContexts = Object.fromEntries(Object.entries(contexts).map(
          ([id, { start, end }]) => [id, { start, end }],
        ));
        const translated = await translationProviderFor(model.provider).translate({
          ...(sourceLanguage ? { sourceLanguage } : {}),
          targetLanguage,
          segments: segments.map(({ id, text }) => ({ id, text })),
          ...(Object.keys(providerContexts).length > 0 ? { contexts: providerContexts } : {}),
          ...(style ? { style } : {}),
          model: model.modelId, ...options,
        });
        await saveAiJsonResult({
          jobId: job.id, userId, filename: `translation-${job.id}.json`,
          providerCostUsd: translated.providerCostUsd,
          result: {
            version: 1, kind: "translation",
            ...(sourceLanguage ? { sourceLanguage } : {}),
            targetLanguage,
            segments: translated.map((segment) => {
              const context = contexts[segment.id];
              return context ? { ...segment, context } : segment;
            }),
          },
        });
        return { ok: true as const, segments: translated };
      } catch (error) {
        // An unresolved refund must propagate, preserving the recovery key.
        await failAiJobAndRefundUsage({
          userId, aiJobId: job.id,
          error: aiJobFailureMessage(error, AI_JOB_FAILURE_MESSAGES.translation),
        });
        if (error instanceof AiProviderError) {
          reportAiProviderFailure({
            operation: "subtitle.translate", jobId: job.id,
            provider: model.provider, model: model.modelId, error,
          });
        }
        return { ok: false as const, error };
      }
    },
  };
}
