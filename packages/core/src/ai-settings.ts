// Registry and validation for administrator-configurable AI settings.
//
// This module contains pure definitions and does not access the database or
// environment. @beutl/api resolves values. Both the admin UI and API worker use
// these definitions so validation remains consistent across entry points.
//
// Only settings that are genuinely one value belong here. Models and their
// usage percentages are per-operation lists an administrator edits at runtime,
// which is the AiOperationModel table; they were briefly in both places, and a value
// that can be typed into two controls is one control that silently does
// nothing.
//
// Secrets such as API keys must never be registered or stored in plaintext here.

// Global billing settings only. Per-model provider and percentage live in the
// AiOperationModel table.
export type AiSettingKind = "limit" | "usd_rate";

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

// Legacy fixed-price bounds retained while old Workers and the compatibility
// column remain deployable. New billing ignores these values.
export const MIN_PRICE_UNITS = 1;
export const MAX_PRICE_UNITS = MAX_MONTHLY_USAGE_LIMIT;
export const MIN_MODEL_USAGE_PERCENT = 1;
export const MAX_MODEL_USAGE_PERCENT = 10_000;

export const AI_PLAN_MONTHLY_USAGE_LIMIT_KEY = "plan.monthlyUsageLimit";
export const AI_PROVIDER_USD_PER_USAGE_UNIT_KEY =
  "billing.providerUsdPerUsageUnit";

// The built-in monthly allowance. This is the only default for the value the
// admin console overrides.
export const DEFAULT_MONTHLY_USAGE_LIMIT = 500;

// One shared conversion replaces per-model unit prices. Provider costs are
// reported in USD, while balances retain up to six fractional usage-unit
// places; one cent per unit is the safe, understandable default and can be
// changed without touching every model row.
export const DEFAULT_PROVIDER_USD_PER_USAGE_UNIT = 0.01;
export const MIN_PROVIDER_USD_PER_USAGE_UNIT = 0.000001;
export const MAX_PROVIDER_USD_PER_USAGE_UNIT = 1_000;

export const AI_IMAGE_EDIT_TASKS = [
  "remove_background",
  "upscale",
  "restyle",
  "remove_object",
  "outpaint",
] as const;

export type AiImageEditTask = (typeof AI_IMAGE_EDIT_TASKS)[number];

// The built-in model and legacy reservation fallback for every operation.
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
  // The three modes that work from a video this service already holds. They
  // exist only on Vercel AI Gateway — OpenRouter's video API has no field for a
  // source video — so their built-in entry names that provider rather than the
  // one every older row carries.
  "video.edit": {
    model: "spacexai/grok-imagine-video",
    price: 40,
    provider: "vercel-gateway",
  },
  "video.extend": {
    model: "spacexai/grok-imagine-video",
    price: 40,
    provider: "vercel-gateway",
  },
  "video.motion": {
    model: "klingai/kling-v3.0-motion-control",
    price: 40,
    provider: "vercel-gateway",
  },
} as const satisfies Record<
  string,
  { model: string; price: number; provider?: string }
>;

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
  [AI_PROVIDER_USD_PER_USAGE_UNIT_KEY]: {
    key: AI_PROVIDER_USD_PER_USAGE_UNIT_KEY,
    kind: "usd_rate",
    fallback: String(DEFAULT_PROVIDER_USD_PER_USAGE_UNIT),
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
  | "limitOutOfRange"
  | "invalidUsdRate"
  | "usdRateOutOfRange";

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
  if (definition.kind === "usd_rate") {
    // At most six decimal places: the job snapshots the conversion rate in
    // micro-USD. Actual provider costs retain their precision until conversion.
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(trimmed)) {
      return { ok: false, error: "invalidUsdRate" };
    }
    const parsed = Number(trimmed);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_PROVIDER_USD_PER_USAGE_UNIT ||
      parsed > MAX_PROVIDER_USD_PER_USAGE_UNIT
    ) {
      return { ok: false, error: "usdRateOutOfRange" };
    }
    return { ok: true, value: String(parsed) };
  }
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
