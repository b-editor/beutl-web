// 管理画面から変更できる AI 設定のレジストリと検証。
//
// DB や環境変数に触れない純粋な定義だけを置く (実際の解決は @beutl/api 側)。
// 管理画面 (apps/admin) と API Worker の両方が同じ値域定義を使うため、
// どちらからも参照できるこのパッケージが定義の置き場になる。
//
// API キーなどの機密情報はここでは扱わない (DB に平文で置かない)。

export type AiSettingKind = "model" | "price";

export type AiSettingDefinition = {
  key: string;
  kind: AiSettingKind;
  // 対応する環境変数。単価は環境変数を持たないため undefined。
  envVar?: string;
  fallback: string;
  // 管理画面のグループ表示に使う操作名 (AI_PRICING_CATALOG のキーと一致)。
  operation: string;
};

// モデル ID は OpenRouter の "provider/model" 形式。長さと文字種だけを検証し、
// 実在するかどうかはプロバイダ呼び出し時のエラーに委ねる (モデル追加のたびに
// この一覧を更新しなくても運用できるようにするため)。
const MODEL_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const MAX_MODEL_ID_LENGTH = 128;

// 単価の上限。Pro プランの月次上限 (500) を 1 操作で使い切る値までを許容する。
// 0 は「無料」を意味し実質無制限利用になってしまうため許可しない。
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

// 既定のモデル ID と単価。ここが唯一の「コード上の既定値」。
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

// 既存の環境変数名との対応。新設のキー (restyle など) は環境変数を持たないため
// undefined になり、DB 未設定時はコード上の既定値が使われる。
const MODEL_ENV_VARS: Partial<Record<AiOperation, string>> = {
  "image.generate": "OPENROUTER_IMAGE_MODEL",
  "image.edit.remove_background":
    "OPENROUTER_IMAGE_EDIT_MODEL_REMOVE_BACKGROUND",
  "image.edit.upscale": "OPENROUTER_IMAGE_EDIT_MODEL_UPSCALE",
  "audio.transcribe": "OPENROUTER_STT_MODEL",
  "subtitle.translate": "OPENROUTER_TRANSLATION_MODEL",
  "video.generate": "OPENROUTER_VIDEO_MODEL",
};

export const AI_OPERATIONS = Object.keys(DEFAULTS) as AiOperation[];

function buildSettings(): Record<string, AiSettingDefinition> {
  const settings: Record<string, AiSettingDefinition> = {};
  for (const operation of AI_OPERATIONS) {
    const defaults = DEFAULTS[operation];
    const envVar = MODEL_ENV_VARS[operation];
    settings[`model.${operation}`] = {
      key: `model.${operation}`,
      kind: "model",
      fallback: defaults.model,
      operation,
      ...(envVar ? { envVar } : {}),
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

export function isAiSettingKey(value: unknown): boolean {
  return typeof value === "string" && value in AI_SETTINGS;
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

// Server Action の引数は実行時に型が消えるため、永続化前に必ずここを通す。
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
  // 単価は整数の使用ユニット数。小数を許すと課金額の丸めが必要になるため拒否する。
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
