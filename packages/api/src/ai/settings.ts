// AI 設定の解決層。
//
// 値域の定義と検証は @beutl/core (ai-settings) が持ち、ここは
// 「DB (AiSetting) → 環境変数 → コード上の既定値」の解決だけを担当する。
// DB に行が無いキーは従来どおり環境変数/既定値で動くため、この仕組みを
// 入れても既存デプロイの挙動は変わらない。
import { getAiSettingMap } from "@beutl/db";
import type { PrismaTransaction } from "@beutl/db";
import {
  AI_SETTINGS,
  aiModelSettingKey,
  aiPriceSettingKey,
  validateAiSettingValue,
  type AiSettingDefinition,
} from "@beutl/core";

export type AiSettingSource = "database" | "environment" | "default";

export type ResolvedAiSetting = AiSettingDefinition & {
  value: string;
  // 現在その値がどこから来ているか。管理画面が「既定のまま」を示すのに使う。
  source: AiSettingSource;
};

function resolveFromEnv(definition: AiSettingDefinition): string | undefined {
  if (!definition.envVar) return undefined;
  const value = process.env[definition.envVar];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveDefinition(
  definition: AiSettingDefinition,
  stored: Map<string, string>,
): ResolvedAiSetting {
  const dbValue = stored.get(definition.key);
  if (dbValue !== undefined) {
    // 保存済みの値も検証を通す。レジストリの値域を後から狭めた場合に、
    // 不正な値をそのままプロバイダや課金へ流さないため。
    const validated = validateAiSettingValue(definition.key, dbValue);
    if (validated.ok) {
      return { ...definition, value: validated.value, source: "database" };
    }
  }
  const envValue = resolveFromEnv(definition);
  if (envValue !== undefined) {
    const validated = validateAiSettingValue(definition.key, envValue);
    if (validated.ok) {
      return { ...definition, value: validated.value, source: "environment" };
    }
  }
  return { ...definition, value: definition.fallback, source: "default" };
}

export type AiSettingsSnapshot = {
  getModel(operation: string): string;
  getPrice(operation: string): number;
  all(): ResolvedAiSetting[];
};

function toSnapshot(stored: Map<string, string>): AiSettingsSnapshot {
  const resolved = new Map<string, ResolvedAiSetting>();
  for (const definition of Object.values(AI_SETTINGS)) {
    resolved.set(definition.key, resolveDefinition(definition, stored));
  }
  const read = (key: string): ResolvedAiSetting => {
    const entry = resolved.get(key);
    if (!entry) {
      throw new Error(`Unknown AI setting key: ${key}`);
    }
    return entry;
  };
  return {
    getModel: (operation) => read(aiModelSettingKey(operation)).value,
    getPrice: (operation) => Number(read(aiPriceSettingKey(operation)).value),
    all: () =>
      Object.values(AI_SETTINGS).map(
        (definition) => resolved.get(definition.key) as ResolvedAiSetting,
      ),
  };
}

export async function loadAiSettings({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}): Promise<AiSettingsSnapshot> {
  const stored = await getAiSettingMap({ prisma });
  return toSnapshot(stored);
}

// 環境変数と既定値だけで解決したスナップショット。DB を参照できない文脈で使う。
export function loadAiSettingsWithoutDatabase(): AiSettingsSnapshot {
  return toSnapshot(new Map());
}
