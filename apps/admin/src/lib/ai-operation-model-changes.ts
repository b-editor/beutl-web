import {
  AI_OPERATIONS,
  MAX_MODEL_ID_LENGTH,
  MAX_PRICE_UNITS,
  MIN_PRICE_UNITS,
  isAiModelId,
} from "@beutl/core";

// Validation for one registered model row.
//
// Model rows are saved one at a time rather than through the settings page's
// batch: a batch is capped at 64 changes and one row already carries five
// fields, so a page with several models per operation would exceed it. The
// cross-field rule that used to live in ai-setting-changes still applies, but
// its meaning is different here and is checked against the other rows in the
// same transaction — see the note on aiOperationWouldGoOffline.
export type AiOperationModelInput = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  sortOrder: number;
  enabled: boolean;
};

export const MAX_MODEL_DISPLAY_NAME_LENGTH = 80;
export const MAX_MODEL_SORT_ORDER = 9_999;

export type AiOperationModelValidation =
  | { ok: true; value: AiOperationModelInput }
  | { ok: false; message: string };

// Server Action arguments lose their type annotations at runtime, so the shape
// is checked here as well as the ranges.
export function validateAiOperationModelInput(
  input: unknown,
): AiOperationModelValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Invalid model" };
  }
  const { operation, modelId, priceUnits, displayName, sortOrder, enabled } =
    input as Record<string, unknown>;

  if (
    typeof operation !== "string" ||
    !(AI_OPERATIONS as readonly string[]).includes(operation)
  ) {
    return { ok: false, message: "Invalid operation" };
  }
  if (typeof modelId !== "string") {
    return { ok: false, message: "Invalid model ID" };
  }
  const trimmedModelId = modelId.trim();
  if (trimmedModelId.length > MAX_MODEL_ID_LENGTH) {
    return { ok: false, message: "Model ID is too long" };
  }
  if (!isAiModelId(trimmedModelId)) {
    return { ok: false, message: "Invalid model ID" };
  }
  if (
    typeof priceUnits !== "number" ||
    !Number.isSafeInteger(priceUnits) ||
    priceUnits < MIN_PRICE_UNITS ||
    priceUnits > MAX_PRICE_UNITS
  ) {
    return { ok: false, message: "Invalid usage-unit price" };
  }
  if (
    typeof sortOrder !== "number" ||
    !Number.isSafeInteger(sortOrder) ||
    sortOrder < 0 ||
    sortOrder > MAX_MODEL_SORT_ORDER
  ) {
    return { ok: false, message: "Invalid display order" };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, message: "Invalid enabled flag" };
  }
  if (displayName !== null && typeof displayName !== "string") {
    return { ok: false, message: "Invalid display name" };
  }
  const trimmedDisplayName =
    displayName === null ? null : displayName.trim() || null;
  if (
    trimmedDisplayName !== null &&
    trimmedDisplayName.length > MAX_MODEL_DISPLAY_NAME_LENGTH
  ) {
    return { ok: false, message: "Display name is too long" };
  }

  return {
    ok: true,
    value: {
      operation,
      modelId: trimmedModelId,
      priceUnits,
      displayName: trimmedDisplayName,
      sortOrder,
      enabled,
    },
  };
}

// Whether the operation would be left with nothing anyone on the plan can
// start.
//
// The single-model rule was "no price above the allowance". With several models
// that is too strict: an expensive model beside an affordable one is a
// deliberate offer, not a misconfiguration. What still must not happen is every
// enabled model landing above the allowance, which takes the operation offline
// for everyone while each field looks valid on its own — an allowance typed one
// digit short does exactly that.
export function aiOperationWouldGoOffline({
  minimumChargeOf,
  models,
  allowance,
}: {
  minimumChargeOf: (priceUnits: number) => number;
  models: { priceUnits: number; enabled: boolean }[];
  allowance: number;
}): boolean {
  const enabled = models.filter((model) => model.enabled);
  if (enabled.length === 0) {
    // No rows at all means the operation falls back to its configured single
    // model, which the settings page validates.
    return false;
  }
  return enabled.every(
    (model) => minimumChargeOf(model.priceUnits) > allowance,
  );
}
