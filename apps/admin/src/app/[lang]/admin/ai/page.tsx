import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import { AI_OPERATIONS, AI_PLAN_MONTHLY_USAGE_LIMIT_KEY } from "@beutl/core";
import { Separator } from "@beutl/ui/ui/separator";
import { Suspense } from "react";
import { AiSettingField } from "./components";
import { AiOperationModels } from "./model-list";
import {
  AiConfigurationForm,
  type AiModelRow,
  type AiSettingRow,
} from "./settings-form";
import {
  AiOfferCards,
  AiOfferCardsFallback,
  AiOperationEconomics,
  AiOperationEconomicsFallback,
} from "./economics";
import { AiUnaffordableAlert } from "./unaffordable-alert";
import { AllowanceDigest, AllowanceDigestFallback } from "./digest";
import { AiTabs } from "./tabs";
import {
  getAiModelCatalog,
  getAiOperationModels,
  getAiSettings,
  getUnusableImageModels,
  getUnusableVideoModels,
} from "./queries";

// Show administrators the latest value immediately after a setting change.
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const [settings, registeredModels, catalog, unusableVideoModels] =
    await Promise.all([
      getAiSettings(),
      getAiOperationModels(),
      getAiModelCatalog(),
      getUnusableVideoModels(),
    ]);
  const monthlyUsageLimit = settings.getMonthlyUsageLimit();
  // An operation with nothing registered still offers the built-in model, and
  // the catalog is where that fallback is resolved; the page shows what a
  // request would actually run on rather than an empty list.
  const modelsOf = (operation: string): AiModelRow[] => {
    const rows = registeredModels.filter((row) => row.operation === operation);
    if (rows.length > 0) {
      return rows.map((row) => ({
        modelId: row.modelId,
        priceUnits: row.priceUnits,
        displayName: row.displayName,
        enabled: row.enabled,
      }));
    }
    return catalog.list(operation).map((entry) => ({
      modelId: entry.modelId,
      priceUnits: entry.priceUnits,
      displayName: null,
      enabled: true,
    }));
  };

  // Per operation, because an image model that cannot take a picture is fine
  // for generation and useless for every edit.
  const unusableImageModels = Object.fromEntries(
    await Promise.all(
      AI_OPERATIONS.filter((operation) => operation.startsWith("image."))
        .map(async (operation) => [
          operation,
          await getUnusableImageModels(
            operation,
            modelsOf(operation).map((model) => model.modelId),
          ),
        ] as const),
    ),
  );
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

      {/* The allowance and every operation's models are committed together by
          one save bar: saving an allowance before the model it was raised for
          is an operation nobody can start. */}
      <AiConfigurationForm
        lang={lang}
        settings={rows}
        models={AI_OPERATIONS.map((operation) => ({
          operation,
          models: modelsOf(operation),
        }))}
      >
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
              modelsByOperation={Object.fromEntries(
                AI_OPERATIONS.map((operation) => [
                  operation,
                  modelsOf(operation).map((model) => ({
                    priceUnits: model.priceUnits,
                    enabled: model.enabled,
                  })),
                ]),
              )}
            />
          </section>

          {/* Every model an operation offers, and nothing else: a second place
              to type a model would be a control that silently does nothing once
              a row exists. */}
          {AI_OPERATIONS.map((operation) => (
              <AiOperationModels
                key={operation}
                lang={lang}
                operation={operation}
                title={t(`admin:ai.operation.${operation}`)}
                warningsByModel={Object.fromEntries(
                  modelsOf(operation)
                    .filter((model) =>
                      unusableVideoModels.has(model.modelId)
                      || unusableImageModels[operation]?.has(model.modelId),
                    )
                    .map((model) => [
                      model.modelId,
                      t("admin:ai.models.unsupportedByProvider"),
                    ]),
                )}
                // Prices and provider costs are network calls, so each figure
                // sits behind its own boundary and the rows stay interactive
                // while they load. They all await the same cached lookup.
                economicsByModel={Object.fromEntries(
                  modelsOf(operation).map((model) => [
                    model.modelId,
                    <Suspense
                      key={model.modelId}
                      fallback={
                        <AiOperationEconomicsFallback
                          lang={lang}
                          operation={operation}
                          model={model.modelId}
                          priceUnits={model.priceUnits}
                        />
                      }
                    >
                      <AiOperationEconomics
                        lang={lang}
                        operation={operation}
                        model={model.modelId}
                        priceUnits={model.priceUnits}
                      />
                    </Suspense>,
                  ]),
                )}
              />
          ))}

          {/* Stated once rather than under every operation. */}
          <p className="text-xs text-muted-foreground">
            {t("admin:ai.economics.costNote")}
          </p>
        </div>
      </AiConfigurationForm>
    </div>
  );
}
