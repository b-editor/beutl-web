// Registry and validation for administrator-configurable AI settings.
//
// This module contains pure definitions and does not access the database or
// environment. @beutl/api resolves values. Both the admin UI and API worker use
// these definitions so validation remains consistent across entry points.
//
// Secrets such as API keys must never be registered or stored in plaintext here.

export type AiSettingKind = "model" | "price" | "limit";

export type AiSettingDefinition = {
  key: string;
  kind: AiSettingKind;
  fallback: string;
  // Operation name used for admin grouping and shared with AI_PRICING_CATALOG.
  // Plan-wide settings apply to no single operation and leave this undefined.
  operation?: string;
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

// A price above the allowance leaves its operation unstartable for everyone, so
// the allowance is the real ceiling. It is configurable, which is why this is
// not a smaller fixed number: pinning it to the built-in default meant raising
// the allowance for a costlier model still needed a redeploy. The pair is
// checked against each other where a batch of edits is saved; this range only
// keeps a single value inside what any allowance could ever be. Zero would make
// an operation effectively unlimited and is not allowed.
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

// The sole source of built-in model and price defaults.
const DEFAULTS = {
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
} as const;

export type AiOperation = keyof typeof DEFAULTS;


export const AI_OPERATIONS = Object.keys(DEFAULTS) as AiOperation[];

function buildSettings(): Record<string, AiSettingDefinition> {
  const settings: Record<string, AiSettingDefinition> = {
    [AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]: {
      key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
      kind: "limit",
      fallback: String(DEFAULT_MONTHLY_USAGE_LIMIT),
    },
  };
  for (const operation of AI_OPERATIONS) {
    const defaults = DEFAULTS[operation];
    settings[`model.${operation}`] = {
      key: `model.${operation}`,
      kind: "model",
      fallback: defaults.model,
      operation,
    };
    settings[`price.${operation}`] = {
      key: `price.${operation}`,
      kind: "price",
      fallback: String(defaults.price),
      operation,
    };
  }
  return settings;
}

export const AI_SETTINGS: Record<string, AiSettingDefinition> = buildSettings();

export function isAiSettingKey(value: unknown): value is keyof typeof AI_SETTINGS {
  return typeof value === "string" && Object.hasOwn(AI_SETTINGS, value);
}

export function aiModelSettingKey(operation: string): string {
  return `model.${operation}`;
}

export function aiPriceSettingKey(operation: string): string {
  return `price.${operation}`;
}

export type AiSettingValidationError =
  | "unknownKey"
  | "invalidModelId"
  | "modelIdTooLong"
  | "invalidPrice"
  | "priceOutOfRange"
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
  if (definition.kind === "model") {
    if (trimmed.length > MAX_MODEL_ID_LENGTH) {
      return { ok: false, error: "modelIdTooLong" };
    }
    if (!MODEL_ID_PATTERN.test(trimmed)) {
      return { ok: false, error: "invalidModelId" };
    }
    return { ok: true, value: trimmed };
  }
  // Prices and allowances are whole usage units; reject values that would
  // require rounding.
  const isLimit = definition.kind === "limit";
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: isLimit ? "invalidLimit" : "invalidPrice" };
  }
  const parsed = Number(trimmed);
  const min = isLimit ? MIN_MONTHLY_USAGE_LIMIT : MIN_PRICE_UNITS;
  const max = isLimit ? MAX_MONTHLY_USAGE_LIMIT : MAX_PRICE_UNITS;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return {
      ok: false,
      error: isLimit ? "limitOutOfRange" : "priceOutOfRange",
    };
  }
  return { ok: true, value: String(parsed) };
}
