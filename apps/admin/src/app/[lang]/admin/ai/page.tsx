import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import { AI_OPERATIONS, aiModelSettingKey, aiPriceSettingKey } from "@beutl/core";
import { loadAiSettings } from "@beutl/api";
import { Separator } from "@beutl/ui/ui/separator";
import { AiSettingField, type AiSettingRow } from "./components";

// 設定は管理者が変更した直後の値を見せる必要があるため、常に最新を読む。
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const settings = await loadAiSettings();
  const byKey = new Map(settings.all().map((entry) => [entry.key, entry]));

  const toRow = (key: string): AiSettingRow => {
    const entry = byKey.get(key);
    if (!entry) {
      throw new Error(`Unknown AI setting key: ${key}`);
    }
    return {
      key: entry.key,
      kind: entry.kind,
      value: entry.value,
      source: entry.source,
      fallback: entry.fallback,
      ...(entry.envVar ? { envVar: entry.envVar } : {}),
    };
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:ai.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("admin:ai.description")}
        </p>
      </div>

      <div className="flex flex-col gap-8">
        {AI_OPERATIONS.map((operation) => (
          <section key={operation} className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {t(`admin:ai.operation.${operation}`)}
              </h2>
              <code className="text-xs text-muted-foreground">{operation}</code>
            </div>
            <Separator />
            <div className="grid gap-3 lg:grid-cols-2">
              <AiSettingField
                lang={lang}
                setting={toRow(aiModelSettingKey(operation))}
              />
              <AiSettingField
                lang={lang}
                setting={toRow(aiPriceSettingKey(operation))}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
