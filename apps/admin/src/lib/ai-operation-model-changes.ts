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
// batch: a batch is capped at 64 changes and one row already carries several
// fields, so a page with several models per operation would exceed it.
//
// The display order is not taken from the caller: the submitted list is the
// order, and its first entry is what a request that names no model runs on.
export type AiOperationModelInput = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  enabled: boolean;
};

export const MAX_MODEL_DISPLAY_NAME_LENGTH = 80;

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
  const { operation, modelId, priceUnits, displayName, enabled } =
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
      enabled,
    },
  };
}

// Whether the operation would be left with nothing anyone on the plan can
// start. The one rule that ties a price to the allowance, checked from both
// sides: saving a model row, and saving the allowance itself.
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
  // Every model disabled is a deliberate "this operation is off", not the
  // accident this guards against.
  if (enabled.length === 0) {
    return false;
  }
  return enabled.every(
    (model) => minimumChargeOf(model.priceUnits) > allowance,
  );
}

// The operations an allowance would take offline, given what each can run on.
// Checked when the allowance is saved; saving a model row checks the same rule
// from the other side.
export function aiOperationsGoingOffline({
  minimumChargeOf,
  modelsByOperation,
  allowance,
}: {
  minimumChargeOf: (operation: string, priceUnits: number) => number;
  modelsByOperation: Record<string, { priceUnits: number; enabled: boolean }[]>;
  allowance: number;
}): string[] {
  return Object.entries(modelsByOperation)
    .filter(([operation, models]) =>
      aiOperationWouldGoOffline({
        minimumChargeOf: (priceUnits) => minimumChargeOf(operation, priceUnits),
        models,
        allowance,
      }),
    )
    .map(([operation]) => operation);
}
