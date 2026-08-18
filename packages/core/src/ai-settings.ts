// Registry and validation for administrator-configurable AI settings.
//
// This module contains pure definitions and does not access the database or
// environment. @beutl/api resolves values. Both the admin UI and API worker use
// these definitions so validation remains consistent across entry points.
//
// Only settings that are genuinely one value belong here. Models and their
// prices are per-operation lists an administrator edits at runtime, which is
// the AiOperationModel table; they were briefly in both places, and a value
// that can be typed into two controls is one control that silently does
// nothing.
//
// Secrets such as API keys must never be registered or stored in plaintext here.

// One kind, because one setting: everything per-operation moved to the
// AiOperationModel table.
export type AiSettingKind = "limit";

export type AiSettingDefinition = {
  key: string;
  kind: AiSettingKind;
  fallback: string;
};

// Model IDs use OpenRouter's "provider/model" form. Validate only their length
// and character set so newly available models do not require a registry update.
const MODEL_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const MAX_MODEL_ID_LENGTH = 128;

// Monthly allowance granted to an active Pro subscription, in usage units.
// Zero is rejected because it silently disables the plan for everyone; use the
// per-user adjustment instead when a single account must be cut off.
export const MIN_MONTHLY_USAGE_LIMIT = 1;
export const MAX_MONTHLY_USAGE_LIMIT = 1_000_000;

// A model priced above the allowance is unstartable for everyone on the plan,
// so the allowance is the real ceiling. It is configurable, which is why this
// is not a smaller fixed number: pinning it to the built-in default meant
// raising the allowance for a costlier model still needed a redeploy. The two
// are checked against each other where a model row or the allowance is saved;
// this range only keeps a single value inside what any allowance could ever be.
// Zero would make an operation effectively unlimited and is not allowed.
export const MIN_PRICE_UNITS = 1;
export const MAX_PRICE_UNITS = MAX_MONTHLY_USAGE_LIMIT;

export const AI_PLAN_MONTHLY_USAGE_LIMIT_KEY = "plan.monthlyUsageLimit";

// The built-in monthly allowance. This is the only default for the value the
// admin console overrides.
export const DEFAULT_MONTHLY_USAGE_LIMIT = 500;

export const AI_IMAGE_EDIT_TASKS = [
  "remove_background",
  "upscale",
  "restyle",
  "remove_object",
  "outpaint",
] as const;

export type AiImageEditTask = (typeof AI_IMAGE_EDIT_TASKS)[number];

// The built-in model and price for every operation.
//
// This is the seed and the last-resort fallback rather than the whole story:
// an operation's selectable models live in the AiOperationModel table, and one
// with no rows there resolves to the entry below. That only happens for an
// operation added in code before it has been registered, since the migration
// seeds a row for every operation that exists today.
export const AI_DEFAULT_OPERATION_MODELS = {
  "image.generate": { model: "openai/gpt-image-1", price: 20 },
  "image.edit.remove_background": { model: "openai/gpt-image-1", price: 10 },
  "image.edit.upscale": { model: "bytedance-seed/seedream-4.5", price: 15 },
  "image.edit.restyle": { model: "openai/gpt-image-1", price: 20 },
  "image.edit.remove_object": { model: "openai/gpt-image-1", price: 20 },
  "image.edit.outpaint": { model: "openai/gpt-image-1", price: 20 },
  "audio.transcribe": {
    model: "openai/whisper-large-v3-turbo",
    price: 5,
  },
  "subtitle.translate": { model: "openai/gpt-4.1-mini", price: 5 },
  "video.generate": { model: "google/veo-3.1", price: 40 },
} as const satisfies Record<string, { model: string; price: number }>;

export type AiOperation = keyof typeof AI_DEFAULT_OPERATION_MODELS;


export const AI_OPERATIONS = Object.keys(
  AI_DEFAULT_OPERATION_MODELS,
) as AiOperation[];

export const AI_SETTINGS: Record<string, AiSettingDefinition> = {
  [AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]: {
    key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
    kind: "limit",
    fallback: String(DEFAULT_MONTHLY_USAGE_LIMIT),
  },
};

export function isAiSettingKey(value: unknown): value is keyof typeof AI_SETTINGS {
  return typeof value === "string" && Object.hasOwn(AI_SETTINGS, value);
}

// A model ID on its own, for the AiOperationModel rows the admin console
// registers. Those are not settings keys, so they cannot go through
// validateAiSettingValue, but they must be held to the same shape.
export function isAiModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MODEL_ID_LENGTH &&
    MODEL_ID_PATTERN.test(value)
  );
}

export type AiSettingValidationError =
  | "unknownKey"
  | "invalidLimit"
  | "limitOutOfRange";

export type AiSettingValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: AiSettingValidationError };

// Server Action arguments lose type information at runtime; always validate
// them here before persistence.
export function validateAiSettingValue(
  key: string,
  value: string,
): AiSettingValidationResult {
  const definition = AI_SETTINGS[key];
  if (!definition) {
    return { ok: false, error: "unknownKey" };
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  // An allowance is whole usage units; reject a value that would need rounding.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "invalidLimit" };
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_MONTHLY_USAGE_LIMIT ||
    parsed > MAX_MONTHLY_USAGE_LIMIT
  ) {
    return { ok: false, error: "limitOutOfRange" };
  }
  return { ok: true, value: String(parsed) };
}
