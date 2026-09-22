import {
  multiplyDecimalAmounts,
  parseNonNegativeDecimalFraction,
  USD_MICROS_PER_DOLLAR,
} from "@beutl/core";
import { loadAiCostEstimates, type AiCostRequestShape } from "./model-pricing";
import type { ProviderCostUsd } from "./provider-cost";

// Public prices can move between reservation and completion, and token-priced
// requests include small fixed prompt costs the catalog estimate omits. The
// excess is only held temporarily; settlement releases it after actual cost is
// known.
export const AI_COST_RESERVATION_BUFFER_PERCENT = 120;

export function providerCostUsdToMicros(costUsd: ProviderCostUsd): number | null {
  const cost = parseNonNegativeDecimalFraction(costUsd);
  if (cost === null) return null;
  const micros = (
    cost.numerator * BigInt(USD_MICROS_PER_DOLLAR) + cost.denominator - BigInt(1)
  ) / cost.denominator;
  return micros <= BigInt(2_147_483_647)
    ? Number(micros)
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
  const input = recordOf(inputParams);
  const quote = await quoteAiOperationReservation({
    operation: billable.operation,
    quantity: billable.quantity,
    modelId,
    provider,
    request: {
      referenceImages: kind === "image"
        ? Array.isArray(input.references) ? input.references.length : 0
        : kind === "image_edit" ? 1 : undefined,
      resolution: typeof input.resolution === "string" ? input.resolution : undefined,
      generateAudio: typeof input.generateAudio === "boolean" ? input.generateAudio : undefined,
      aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : undefined,
      background: typeof input.background === "string" ? input.background : undefined,
    },
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
  request = {},
}: {
  operation: string;
  quantity: number;
  modelId: string;
  provider: string;
  request?: AiCostRequestShape;
}): Promise<{
  estimatedProviderCostUsd: number;
  reservationProviderCostUsd: number;
} | null> {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const { entries } = await loadAiCostEstimates({
    modelsOf: (candidate) =>
      candidate === operation ? [{ modelId, provider }] : [],
    request: {
      ...request,
      referenceImages: operation === "image.generate"
        ? request.referenceImages ?? 0
        : operation.startsWith("image.edit.") ? 1 : undefined,
      ...(operation === "image.generate" ? { aspectRatio: request.aspectRatio ?? "1:1" } : {}),
      // Match the generation entry points' defaults. Source-video operations
      // inherit the clip's shape, so an absent resolution must remain unknown.
      ...(operation === "video.generate" ? {
        resolution: request.resolution ?? "720p",
        generateAudio: request.generateAudio ?? true,
        aspectRatio: request.aspectRatio ?? "16:9",
      } : {}),
    },
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
