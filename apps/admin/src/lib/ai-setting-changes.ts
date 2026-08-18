import {
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  isAiSettingKey,
  validateAiSettingValue,
} from "@beutl/core";

// Validation for a batch of AI setting edits saved together.
//
// Server Action arguments lose their type annotations at runtime, so the shape
// is checked here as well as the value ranges. The batch is accepted or
// rejected as a whole.
//
// What the allowance has to be checked against — every model's price — is not
// in this batch and not in this module: it is rows in a table, so that rule
// lives with the rows, in ai-operation-model-changes.
export type AiSettingChange = {
  key: string;
  // null resets the setting to its built-in default by removing the row.
  value: string | null;
};

export const MAX_CHANGES_PER_SAVE = 64;

export type AiSettingChangesResult =
  // The allowance the batch leaves in force, which the caller checks against
  // the registered models before committing.
  | { ok: true; changes: AiSettingChange[]; allowance: number }
  | { ok: false; message: string };

export function validateAiSettingChanges(
  input: unknown,
  // The stored value of any setting this batch does not touch.
  currentValueOf: (key: string) => string,
): AiSettingChangesResult {
  // An empty list is not an empty save: the same submission carries the model
  // rows, and changing only those is the ordinary case.
  if (!Array.isArray(input)) {
    return { ok: false, message: "Invalid setting changes" };
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

  const submitted = new Map(changes.map((change) => [change.key, change.value]));
  // A null resets the setting, which puts its built-in default in force.
  const allowance = Number(
    submitted.has(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY)
      ? submitted.get(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY) ??
          AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]!.fallback
      : currentValueOf(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY),
  );
  if (!Number.isSafeInteger(allowance) || allowance <= 0) {
    return { ok: false, message: "Invalid monthly allowance" };
  }

  return { ok: true, changes, allowance };
}
