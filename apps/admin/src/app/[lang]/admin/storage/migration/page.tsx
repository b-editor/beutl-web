import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import { getStorageStores } from "@/lib/storage";
import { StorageBatchPanel } from "../components";
import { HelpPopover } from "@/components/admin/help-popover";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);

  let stores: Awaited<ReturnType<typeof getStorageStores>> | null = null;
  let configError: string | null = null;
  try {
    stores = await getStorageStores();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  const [primary, fallback] = stores?.stores ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-1">
        <h1 className="text-2xl font-bold">{t("admin:storage.migration.title")}</h1>
        <HelpPopover lang={lang} title={t("admin:storage.migration.title")}>
          {t("admin:storage.migration.description")}
        </HelpPopover>
      </div>

      {configError ? (
        <p className="rounded-lg border border-destructive p-4 text-sm text-destructive">
          {t("admin:storage.stores.configError", { error: configError })}
        </p>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <p className="text-xs text-muted-foreground">{t("admin:storage.stores.primary")}</p>
            <p className="mt-1 font-medium">{primary?.label ?? t("admin:storage.stores.none")}</p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <p className="text-xs text-muted-foreground">{t("admin:storage.stores.fallback")}</p>
            <p className="mt-1 font-medium">{fallback?.label ?? t("admin:storage.stores.none")}</p>
          </div>
        </section>
      )}

      {stores && stores.stores.length > 1 && (
        <StorageBatchPanel
          lang={lang}
          destinations={stores.stores.map((store) => ({
            provider: store.provider,
            label: store.label,
          }))}
          defaultTo={stores.primary}
        />
      )}
    </div>
  );
}
