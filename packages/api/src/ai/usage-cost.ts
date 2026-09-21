import { multiplyDecimalAmounts, USD_MICROS_PER_DOLLAR } from "@beutl/core";
import { loadAiCostEstimates } from "./model-pricing";

// Public prices can move between reservation and completion, and token-priced
// requests include small fixed prompt costs the catalog estimate omits. The
// excess is only held temporarily; settlement releases it after actual cost is
// known.
export const AI_COST_RESERVATION_BUFFER_PERCENT = 120;

export function providerCostUsdToMicros(costUsd: number): number | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  const scaled = costUsd * USD_MICROS_PER_DOLLAR;
  const micros = Math.ceil(
    scaled - Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8,
  );
  return Number.isSafeInteger(micros) && micros <= 2_147_483_647
    ? micros
    : null;
}

function recordOf(value: object | undefined): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function billableRequestOf({
  kind,
  inputParams,
}: {
  kind: string;
  inputParams?: object;
}): { operation: string; quantity: number } | null {
  const input = recordOf(inputParams);
  if (kind === "image") return { operation: "image.generate", quantity: 1 };
  if (kind === "image_edit") {
    const task = typeof input.task === "string" ? input.task : "";
    return task ? { operation: `image.edit.${task}`, quantity: 1 } : null;
  }
  if (kind === "stt") {
    const seconds = positiveNumber(input.durationSeconds);
    return seconds === null
      ? null
      : { operation: "audio.transcribe", quantity: Math.ceil(seconds / 60) };
  }
  if (kind === "translation") {
    const characters = positiveNumber(input.characterCount);
    return characters === null
      ? null
      : {
          operation: "subtitle.translate",
          quantity: Math.max(1, Math.ceil(characters / 1_000)),
        };
  }
  if (kind === "video") {
    const seconds = positiveNumber(input.durationSeconds);
    if (seconds === null) return null;
    const mode = input.mode;
    const operation = mode === "edit"
      ? "video.edit"
      : mode === "extend"
        ? "video.extend"
        : mode === "motion"
          ? "video.motion"
          : "video.generate";
    return { operation, quantity: seconds };
  }
  return null;
}

export async function quoteAiUsageReservation({
  kind,
  inputParams,
  modelId,
  provider,
}: {
  kind: string;
  inputParams?: object;
  modelId: string;
  provider: string;
}): Promise<{
  providerCostUsd: number;
  estimatedProviderCostUsd: number;
  operation: string;
} | null> {
  const billable = billableRequestOf({ kind, inputParams });
  if (!billable) return null;
  const quote = await quoteAiOperationReservation({
    operation: billable.operation,
    quantity: billable.quantity,
    modelId,
    provider,
  });
  return quote === null
    ? null
    : {
        providerCostUsd: quote.reservationProviderCostUsd,
        estimatedProviderCostUsd: quote.estimatedProviderCostUsd,
        operation: billable.operation,
      };
}

export async function quoteAiOperationReservation({
  operation,
  quantity,
  modelId,
  provider,
}: {
  operation: string;
  quantity: number;
  modelId: string;
  provider: string;
}): Promise<{
  estimatedProviderCostUsd: number;
  reservationProviderCostUsd: number;
} | null> {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const { entries } = await loadAiCostEstimates({
    modelsOf: (candidate) =>
      candidate === operation ? [{ modelId, provider }] : [],
  });
  const estimate = entries[0]?.estimate;
  if (!estimate || estimate.status !== "estimated") return null;
  const estimatedProviderCostUsd = multiplyDecimalAmounts(
    estimate.usdMax,
    quantity,
  );
  const reservationProviderCostUsd = multiplyDecimalAmounts(
    estimatedProviderCostUsd,
    AI_COST_RESERVATION_BUFFER_PERCENT / 100,
  );
  return Number.isFinite(reservationProviderCostUsd) &&
      reservationProviderCostUsd > 0
    ? { estimatedProviderCostUsd, reservationProviderCostUsd }
    : null;
}
