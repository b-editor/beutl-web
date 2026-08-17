import { isAiSettingKey, validateAiSettingValue } from "@beutl/core";

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

  return { ok: true, changes };
}
