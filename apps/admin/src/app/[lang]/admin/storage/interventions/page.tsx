import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import {
  getStorageMultipartInterventions,
  getStorageUploadInterventions,
} from "../../ai/queries";
import {
  StorageMultipartInterventions,
  StorageUploadInterventions,
} from "../../ai/storage-interventions";
import { HelpPopover } from "@/components/admin/help-popover";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const [storageInterventions, storageUploadInterventions] = await Promise.all([
    getStorageMultipartInterventions(),
    getStorageUploadInterventions(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:storage.interventions.title")}</h1>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold">{t("admin:ai.interventions.multipart.title")}</h2>
          <HelpPopover lang={lang} title={t("admin:ai.interventions.multipart.title")}>
            {t("admin:ai.interventions.multipart.description")}
          </HelpPopover>
        </div>
        <StorageMultipartInterventions
          lang={lang}
          rows={storageInterventions.map((row) => ({
            ...row,
            interventionAt: row.interventionAt!,
          }))}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold">{t("admin:ai.interventions.upload.title")}</h2>
          <HelpPopover lang={lang} title={t("admin:ai.interventions.upload.title")}>
            {t("admin:ai.interventions.upload.description")}
          </HelpPopover>
        </div>
        <StorageUploadInterventions
          lang={lang}
          rows={storageUploadInterventions.map((row) => ({
            ...row,
            completionInterventionAt: row.completionInterventionAt!,
            completionState: row.completionState,
          }))}
        />
      </section>
    </div>
  );
}
