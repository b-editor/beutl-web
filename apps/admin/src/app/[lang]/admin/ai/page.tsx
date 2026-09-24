import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import {
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_PROVIDER_USD_PER_USAGE_UNIT_KEY,
} from "@beutl/core";
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
} from "./economics";
import { AllowanceDigest, AllowanceDigestFallback } from "./digest";
import { HelpPopover } from "@/components/admin/help-popover";
import {
  getAiModelCatalog,
  getAiOperationModels,
  getAiSettings,
  getUnusableImageModels,
  getUnusableVideoModels,
} from "./queries";
import type { AiOperationModelSnapshot } from "@/lib/ai-configuration-changes";

// Show administrators the latest value immediately after a setting change.
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const [settings, registeredModels, catalog] =
    await Promise.all([
      getAiSettings(),
      getAiOperationModels(),
      getAiModelCatalog(),
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
        provider: row.provider,
        usagePercent: row.usagePercent,
        videoAudioRequired: row.videoAudioRequired,
        imageSizeMode: row.imageSizeMode as AiModelRow["imageSizeMode"],
        imageOutputTokenProfile: row.imageOutputTokenProfile as AiModelRow["imageOutputTokenProfile"],
        priceUnits: row.priceUnits,
        displayName: row.displayName,
        enabled: row.enabled,
      }));
    }
    return catalog.list(operation).map((entry) => ({
      modelId: entry.modelId,
      provider: entry.provider,
      usagePercent: entry.usagePercent,
      videoAudioRequired: entry.videoAudioRequired,
      imageSizeMode: entry.imageSizeMode,
      imageOutputTokenProfile: entry.imageOutputTokenProfile,
      priceUnits: entry.priceUnits,
      displayName: null,
      enabled: true,
    }));
  };
  const modelSnapshots: { operation: string; models: AiOperationModelSnapshot[] }[] =
    AI_OPERATIONS.map((operation) => ({
      operation,
      models: registeredModels
        .filter((row) => row.operation === operation)
        .map((row) => ({
          modelId: row.modelId,
          provider: row.provider,
          usagePercent: row.usagePercent,
          videoAudioRequired: row.videoAudioRequired,
          imageSizeMode: row.imageSizeMode as AiOperationModelSnapshot["imageSizeMode"],
          imageOutputTokenProfile: row.imageOutputTokenProfile as AiOperationModelSnapshot["imageOutputTokenProfile"],
          priceUnits: row.priceUnits,
          displayName: row.displayName,
          enabled: row.enabled,
          sortOrder: row.sortOrder,
          updatedAt: row.updatedAt.toISOString(),
        })),
    }));

  // Per operation as well. video.motion runs on models that publish
  // motion-control and nothing else, so the generation question condemns them.
  const unusableVideoModels = Object.fromEntries(
    await Promise.all(
      AI_OPERATIONS.filter((operation) => operation.startsWith("video."))
        .map(async (operation) => [
          operation,
          await getUnusableVideoModels(
            operation,
            modelsOf(operation).map((model) => ({
              modelId: model.modelId,
              provider: model.provider,
            })),
          ),
        ] as const),
    ),
  );
  // Per operation, because an image model that cannot take a picture is fine
  // for generation and useless for every edit.
  const unusableImageModels = Object.fromEntries(
    await Promise.all(
      AI_OPERATIONS.filter((operation) => operation.startsWith("image."))
        .map(async (operation) => [
          operation,
          await getUnusableImageModels(
            operation,
            modelsOf(operation).map((model) => ({
              modelId: model.modelId,
              provider: model.provider,
            })),
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
      <div className="flex items-center gap-1">
        <h1 className="text-2xl font-bold">{t("admin:ai.title")}</h1>
        <HelpPopover lang={lang} title={t("admin:ai.title")}>
          <p>{t("admin:ai.description")}</p>
          <p>{t("admin:ai.models.description")}</p>
          <p>{t("admin:ai.billingUnitsHelp")}</p>
        </HelpPopover>
      </div>

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
        modelSnapshots={modelSnapshots}
      >
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-1">
              <h2 className="text-lg font-semibold">
                {t("admin:ai.plan.title")}
              </h2>
              <HelpPopover lang={lang} title={t("admin:ai.plan.title")}>
                {t("admin:ai.plan.description")}
              </HelpPopover>
            </div>
            <Separator />
            <div className="grid gap-3 lg:grid-cols-2">
              <AiSettingField
                lang={lang}
                settingKey={AI_PLAN_MONTHLY_USAGE_LIMIT_KEY}
              />
              <AiSettingField
                lang={lang}
                settingKey={AI_PROVIDER_USD_PER_USAGE_UNIT_KEY}
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
            {/* The current subscription and top-up prices. */}
            <Suspense
              fallback={
                <AiOfferCardsFallback label={t("admin:ai.economics.loading")} />
              }
            >
              <AiOfferCards lang={lang} />
            </Suspense>
          </section>

          {/* Every model an operation offers, and nothing else: a second place
              to type a model would be a control that silently does nothing once
              a row exists. */}
          {(["image", "audio", "video"] as const).map((group) => (
            <section key={group} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <h2 className="text-lg font-semibold">{t(`admin:ai.group.${group}`)}</h2>
              {AI_OPERATIONS.filter((operation) =>
                group === "image"
                  ? operation.startsWith("image.")
                  : group === "audio"
                    ? operation.startsWith("audio.") || operation.startsWith("subtitle.")
                    : operation.startsWith("video."),
              ).map((operation) => (
                <AiOperationModels
                  key={operation}
                  lang={lang}
                  operation={operation}
                  title={t(`admin:ai.operation.${operation}`)}
                  warningsByModel={Object.fromEntries(
                    modelsOf(operation)
                      .filter((model) =>
                        unusableVideoModels[operation]?.has(model.modelId)
                        || unusableImageModels[operation]?.has(model.modelId),
                      )
                      .map((model) => [
                        model.modelId,
                        t("admin:ai.models.unsupportedByProvider"),
                      ]),
                  )}
                />
              ))}
            </section>
          ))}
        </div>
      </AiConfigurationForm>
    </div>
  );
}
