import {
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  aiMinimumChargeOf,
  isAiSettingKey,
  validateAiSettingValue,
} from "@beutl/core";

// Validation for a batch of AI setting edits saved together.
//
// Server Action arguments lose their type annotations at runtime, so the shape
// is checked here as well as the value ranges. The batch is accepted or
// rejected as a whole: persisting the valid half of a repricing would leave
// some operations on the new rate and some on the old one.
export type AiSettingChange = {
  key: string;
  // null resets the setting to its built-in default by removing the row.
  value: string | null;
};

export const MAX_CHANGES_PER_SAVE = 64;

export type AiSettingChangesResult =
  | { ok: true; changes: AiSettingChange[] }
  | { ok: false; message: string };

export function validateAiSettingChanges(
  input: unknown,
  // The stored value of any setting this batch does not touch. Prices and the
  // allowance constrain each other, and only the batch knows what both will be
  // once it lands.
  currentValueOf: (key: string) => string,
): AiSettingChangesResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: "No changes were submitted" };
  }
  if (input.length > MAX_CHANGES_PER_SAVE) {
    return { ok: false, message: "Too many changes were submitted" };
  }

  const seen = new Set<string>();
  const changes: AiSettingChange[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "Invalid setting change" };
    }
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (!isAiSettingKey(key)) {
      return { ok: false, message: "Invalid setting key" };
    }
    if (seen.has(key)) {
      return { ok: false, message: `Duplicate setting key: ${key}` };
    }
    seen.add(key);

    if (value === null) {
      changes.push({ key, value: null });
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, message: "Invalid setting value" };
    }
    const validated = validateAiSettingValue(key, value);
    if (!validated.ok) {
      return {
        ok: false,
        message: `Invalid value for ${key}: ${validated.error}`,
      };
    }
    changes.push({ key, value: validated.value });
  }

  // An operation priced above the allowance can never be started by anyone on
  // the plan. Each value passes its own range check, so nothing but a
  // whole-batch comparison catches an allowance typed one digit short — which
  // would take every operation offline while every field still looked valid.
  const submitted = new Map(changes.map((change) => [change.key, change.value]));
  const effectiveValueOf = (key: string): string => {
    if (!submitted.has(key)) return currentValueOf(key);
    // A null resets the setting, which puts its built-in default in force.
    return submitted.get(key) ?? AI_SETTINGS[key].fallback;
  };

  const allowance = Number(effectiveValueOf(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY));
  if (!Number.isSafeInteger(allowance) || allowance <= 0) {
    return { ok: false, message: "Invalid monthly allowance" };
  }
  for (const definition of Object.values(AI_SETTINGS)) {
    if (definition.kind !== "price") continue;
    const price = Number(effectiveValueOf(definition.key));
    if (!Number.isSafeInteger(price)) continue;
    // The smallest request the operation accepts, not one billing unit: a
    // video is charged for at least four seconds, so a price a quarter of the
    // allowance already takes it offline.
    const minimumCharge =
      definition.operation === undefined
        ? price
        : (aiMinimumChargeOf(definition.operation, price) ?? price);
    if (minimumCharge > allowance) {
      return {
        ok: false,
        message: `${definition.key} costs ${minimumCharge} units at its smallest request, above the ${allowance} unit monthly allowance`,
      };
    }
  }

  return { ok: true, changes };
}
