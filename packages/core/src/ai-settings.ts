// Registry and validation for administrator-configurable AI settings.
//
// This module contains pure definitions and does not access the database or
// environment. @beutl/api resolves values. Both the admin UI and API worker use
// these definitions so validation remains consistent across entry points.
//
// Secrets such as API keys must never be registered or stored in plaintext here.

export type AiSettingKind = "model" | "price";

export type AiSettingDefinition = {
  key: string;
  kind: AiSettingKind;
  fallback: string;
  // Operation name used for admin grouping and shared with AI_PRICING_CATALOG.
  operation: string;
};

// Model IDs use OpenRouter's "provider/model" form. Validate only their length
// and character set so newly available models do not require a registry update.
const MODEL_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const MAX_MODEL_ID_LENGTH = 128;

// Permit at most the entire Pro monthly allowance (500) for one operation.
// Zero would make an operation effectively unlimited and is not allowed.
export const MIN_PRICE_UNITS = 1;
export const MAX_PRICE_UNITS = 500;

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
  const settings: Record<string, AiSettingDefinition> = {};
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
  | "priceOutOfRange";

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
  // Prices are whole usage units; reject values that would require rounding.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "invalidPrice" };
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_PRICE_UNITS ||
    parsed > MAX_PRICE_UNITS
  ) {
    return { ok: false, error: "priceOutOfRange" };
  }
  return { ok: true, value: String(parsed) };
}
