import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import {
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  aiModelSettingKey,
  aiPriceSettingKey,
} from "@beutl/core";
import { Separator } from "@beutl/ui/ui/separator";
import { Suspense } from "react";
import { AiSettingField } from "./components";
import { AiOperationModels } from "./model-list";
import { AiSettingsForm, type AiSettingRow } from "./settings-form";
import {
  AiOfferCards,
  AiOfferCardsFallback,
  AiOperationEconomics,
  AiOperationEconomicsFallback,
} from "./economics";
import { AiUnaffordableAlert } from "./unaffordable-alert";
import { AllowanceDigest, AllowanceDigestFallback } from "./digest";
import { AiTabs } from "./tabs";
import { getAiOperationModels, getAiSettings } from "./queries";

// Show administrators the latest value immediately after a setting change.
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const [settings, registeredModels] = await Promise.all([
    getAiSettings(),
    getAiOperationModels(),
  ]);
  const monthlyUsageLimit = settings.getMonthlyUsageLimit();
  const rows: AiSettingRow[] = settings.all().map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    value: entry.value,
    source: entry.source,
    fallback: entry.fallback,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:ai.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("admin:ai.description")}
        </p>
      </div>

      <AiTabs lang={lang} />

      {/* Every field on this page is committed together by one save bar. */}
      <AiSettingsForm lang={lang} settings={rows}>
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {t("admin:ai.plan.title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("admin:ai.plan.description")}
              </p>
            </div>
            <Separator />
            <div className="grid gap-3 lg:grid-cols-2">
              <AiSettingField
                lang={lang}
                settingKey={AI_PLAN_MONTHLY_USAGE_LIMIT_KEY}
              />
            </div>
            <Suspense
              fallback={
                <AllowanceDigestFallback
                  label={t("admin:ai.plan.digestLoading")}
                />
              }
            >
              <AllowanceDigest
                lang={lang}
                monthlyUsageLimit={monthlyUsageLimit}
              />
            </Suspense>
            {/* The two prices every per-operation figure below derives from. */}
            <Suspense
              fallback={
                <AiOfferCardsFallback label={t("admin:ai.economics.loading")} />
              }
            >
              <AiOfferCards lang={lang} />
            </Suspense>
            <AiUnaffordableAlert
              lang={lang}
              registeredModels={Object.fromEntries(
                AI_OPERATIONS.map((operation) => [
                  operation,
                  registeredModels
                    .filter((model) => model.operation === operation)
                    .map((model) => ({
                      priceUnits: model.priceUnits,
                      enabled: model.enabled,
                    })),
                ]),
              )}
            />
          </section>

          {AI_OPERATIONS.map((operation) => (
            <section key={operation} className="flex flex-col gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  {t(`admin:ai.operation.${operation}`)}
                </h2>
                <code className="text-xs text-muted-foreground">
                  {operation}
                </code>
              </div>
              <Separator />
              {/* The single model the operation falls back to while it has no
                  registered rows. */}
              <div className="grid gap-3 lg:grid-cols-2">
                <AiSettingField
                  lang={lang}
                  settingKey={aiModelSettingKey(operation)}
                />
                <AiSettingField
                  lang={lang}
                  settingKey={aiPriceSettingKey(operation)}
                />
              </div>
              <AiOperationModels
                lang={lang}
                operation={operation}
                models={registeredModels
                  .filter((model) => model.operation === operation)
                  .map((model) => ({
                    operation: model.operation,
                    modelId: model.modelId,
                    priceUnits: model.priceUnits,
                    displayName: model.displayName,
                    sortOrder: model.sortOrder,
                    enabled: model.enabled,
                  }))}
              />
              {/* Prices and provider costs are network calls. Each section
                  keeps its own boundary so the fields stay interactive, and
                  they all await the same cached lookup. */}
              <Suspense
                fallback={
                  <AiOperationEconomicsFallback
                    lang={lang}
                    operation={operation}
                    model={settings.getModel(operation)}
                    priceUnits={null}
                  />
                }
              >
                <AiOperationEconomics lang={lang} operation={operation} />
              </Suspense>
            </section>
          ))}

          {/* Stated once rather than under every operation. */}
          <p className="text-xs text-muted-foreground">
            {t("admin:ai.economics.costNote")}
          </p>
        </div>
      </AiSettingsForm>
    </div>
  );
}
