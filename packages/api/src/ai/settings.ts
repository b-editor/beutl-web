// AI setting resolution layer.
//
// @beutl/core owns the definitions and validation. This module only resolves
// database values and built-in defaults in that order. Missing database rows
// fall back to the built-in default; model names are configured exclusively
// through the admin console.
import { getAiSettingMap } from "@beutl/db";
import type { PrismaTransaction } from "@beutl/db";
import {
  AI_SETTINGS,
  aiModelSettingKey,
  aiPriceSettingKey,
  validateAiSettingValue,
  type AiSettingDefinition,
} from "@beutl/core";

export type AiSettingSource = "database" | "default";

export type ResolvedAiSetting = AiSettingDefinition & {
  value: string;
  // Lets the admin UI identify whether the value is still using a fallback.
  source: AiSettingSource;
};

function resolveDefinition(
  definition: AiSettingDefinition,
  stored: Map<string, string>,
): ResolvedAiSetting {
  const dbValue = stored.get(definition.key);
  if (dbValue !== undefined) {
    // Revalidate persisted values so a future registry restriction cannot pass
    // a now-invalid value through to the provider or billing logic.
    const validated = validateAiSettingValue(definition.key, dbValue);
    if (validated.ok) {
      return { ...definition, value: validated.value, source: "database" };
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
