import { AI_OPERATIONS } from "@beutl/core";
import {
  aiOperationsGoingOffline,
  validateAiOperationModelInput,
  type AiOperationModelInput,
} from "./ai-operation-model-changes";
import {
  validateAiSettingChanges,
  type AiSettingChange,
} from "./ai-setting-changes";

// One save for the whole AI configuration.
//
// The allowance and the models used to be committed separately, which made
// every ordering between them a state someone could be looking at: an allowance
// saved before the model it was raised for is an operation nobody can start,
// and the reverse refuses the model until the allowance lands. Validating and
// committing them together means the only state anyone sees is the one that was
// intended.
//
// A submitted operation carries its entire list rather than a set of edits, so
// adding, repricing, removing and reordering are the same thing to the server:
// the rows it does not mention are gone, and the order it gives is the display
// order with the first entry as the default.
export type AiOperationModelsDraft = {
  operation: string;
  models: AiOperationModelInput[];
  expected: AiOperationModelSnapshot[];
};

export type AiOperationModelSnapshot = {
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string;
};

export function matchesAiOperationModelSnapshot(
  actual: readonly AiOperationModelSnapshot[],
  expected: readonly AiOperationModelSnapshot[],
): boolean {
  return actual.length === expected.length && actual.every((row, index) => {
    const snapshot = expected[index];
    return snapshot !== undefined &&
      row.modelId === snapshot.modelId &&
      row.priceUnits === snapshot.priceUnits &&
      row.displayName === snapshot.displayName &&
      row.enabled === snapshot.enabled &&
      row.sortOrder === snapshot.sortOrder &&
      row.updatedAt === snapshot.updatedAt;
  });
}

export type AiConfigurationChanges = {
  settings: AiSettingChange[];
  models: AiOperationModelsDraft[];
};

// Enough for a page of every operation with a handful of models each, and far
// short of anything a person types by hand.
export const MAX_MODELS_PER_OPERATION = 20;

export type AiConfigurationValidation =
  | ({ ok: true; allowance: number } & AiConfigurationChanges)
  | { ok: false; message: string };

export function validateAiConfigurationChanges(
  input: unknown,
  {
    currentSettingValueOf,
    storedModelsOf,
    builtInModelsOf,
    minimumChargeOf,
  }: {
    // The stored value of any setting this save does not touch.
    currentSettingValueOf: (key: string) => string;
    // What an operation this save does not touch can run on, which for one with
    // no rows is already its built-in model.
    storedModelsOf: (
      operation: string,
    ) => { priceUnits: number; enabled: boolean }[];
    // What one runs on once this save leaves it with no rows, which the stored
    // state cannot answer because those rows are the ones going away.
    builtInModelsOf: (
      operation: string,
    ) => { priceUnits: number; enabled: boolean }[];
    minimumChargeOf: (operation: string, priceUnits: number) => number;
  },
): AiConfigurationValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Invalid changes" };
  }
  const { settings, models } = input as Record<string, unknown>;

  const validatedSettings = validateAiSettingChanges(
    settings ?? [],
    currentSettingValueOf,
  );
  if (!validatedSettings.ok) {
    return { ok: false, message: validatedSettings.message };
  }

  if (!Array.isArray(models)) {
    return { ok: false, message: "Invalid model changes" };
  }
  const drafts: AiOperationModelsDraft[] = [];
  const seenOperations = new Set<string>();
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "Invalid model changes" };
    }
    const { operation, models: rows, expected } = entry as Record<string, unknown>;
    if (
      typeof operation !== "string" ||
      !(AI_OPERATIONS as readonly string[]).includes(operation)
    ) {
      return { ok: false, message: "Invalid operation" };
    }
    if (seenOperations.has(operation)) {
      return { ok: false, message: `Duplicate operation: ${operation}` };
    }
    seenOperations.add(operation);

    if (!Array.isArray(rows)) {
      return { ok: false, message: "Invalid model changes" };
    }
    if (!Array.isArray(expected)) {
      return { ok: false, message: "Invalid model snapshot" };
    }
    if (expected.length > MAX_MODELS_PER_OPERATION) {
      return { ok: false, message: "Too many models in snapshot" };
    }
    if (rows.length > MAX_MODELS_PER_OPERATION) {
      return { ok: false, message: `Too many models for ${operation}` };
    }
    const validatedRows: AiOperationModelInput[] = [];
    const seenModelIds = new Set<string>();
    for (const row of rows) {
      const validated = validateAiOperationModelInput({ ...(row as object), operation });
      if (!validated.ok) {
        return { ok: false, message: validated.message };
      }
      if (seenModelIds.has(validated.value.modelId)) {
        return {
          ok: false,
          message: `Duplicate model for ${operation}: ${validated.value.modelId}`,
        };
      }
      seenModelIds.add(validated.value.modelId);
      validatedRows.push(validated.value);
    }
    const validatedExpected: AiOperationModelSnapshot[] = [];
    for (const snapshot of expected) {
      if (typeof snapshot !== "object" || snapshot === null) {
        return { ok: false, message: "Invalid model snapshot" };
      }
      const value = snapshot as Record<string, unknown>;
      if (
        typeof value.modelId !== "string" ||
        typeof value.priceUnits !== "number" ||
        !Number.isSafeInteger(value.priceUnits) ||
        value.priceUnits < 0 ||
        (value.displayName !== null && typeof value.displayName !== "string") ||
        typeof value.enabled !== "boolean" ||
        typeof value.sortOrder !== "number" ||
        !Number.isSafeInteger(value.sortOrder) ||
        value.sortOrder < 0 ||
        typeof value.updatedAt !== "string" ||
        !Number.isFinite(new Date(value.updatedAt).getTime())
      ) {
        return { ok: false, message: "Invalid model snapshot" };
      }
      validatedExpected.push({
        modelId: value.modelId,
        priceUnits: value.priceUnits,
        displayName: value.displayName as string | null,
        enabled: value.enabled,
        sortOrder: value.sortOrder,
        updatedAt: value.updatedAt,
      });
    }
    drafts.push({ operation, models: validatedRows, expected: validatedExpected });
  }

  if (validatedSettings.changes.length === 0 && drafts.length === 0) {
    return { ok: false, message: "No changes were submitted" };
  }

  // The whole state this save would produce, so the allowance is measured
  // against the prices landing with it rather than the ones already stored.
  const submitted = new Map(drafts.map((draft) => [draft.operation, draft]));
  const offline = aiOperationsGoingOffline({
    minimumChargeOf,
    modelsByOperation: Object.fromEntries(
      AI_OPERATIONS.map((operation) => {
        const draft = submitted.get(operation);
        if (!draft) {
          return [operation, storedModelsOf(operation)];
        }
        // Removing every row is allowed; the operation then runs on its
        // built-in model, and that is what the allowance has to cover.
        if (draft.models.length === 0) {
          return [operation, builtInModelsOf(operation)];
        }
        return [
          operation,
          draft.models.map((model) => ({
            priceUnits: model.priceUnits,
            enabled: model.enabled,
          })),
        ];
      }),
    ),
    allowance: validatedSettings.allowance,
  });
  if (offline.length > 0) {
    return {
      ok: false,
      message: `A ${validatedSettings.allowance} unit allowance cannot start any model registered for ${offline.join(", ")}`,
    };
  }

  return {
    ok: true,
    settings: validatedSettings.changes,
    models: drafts,
    allowance: validatedSettings.allowance,
  };
}
