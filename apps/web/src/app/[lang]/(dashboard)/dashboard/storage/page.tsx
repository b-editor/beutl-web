import { Progress } from "@beutl/ui/ui/progress";
import { authOrSignIn } from "@/lib/auth-guard";
import { formatBytes, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { retrieveFiles, retrieveStorageUsage } from "./actions";
import { List } from "./list";
import { getTranslation } from "@beutl/i18n";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  await authOrSignIn();
  const { t } = await getTranslation(lang);
  const [files, usage] = await Promise.all([
    retrieveFiles(),
    retrieveStorageUsage(),
  ]);
  const totalSize = Number(usage.total);
  // 一覧に出ないぶん。AI の生成結果はこの画面では管理しないが、容量は使っている。
  const hiddenSize = Number(usage.total - usage.listed);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{t("storage:storage")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("storage:storageUsage", { totalSize: formatBytes(totalSize) })}
        </p>
        {hiddenSize > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("storage:aiResultUsage", { size: formatBytes(hiddenSize) })}
          </p>
        )}
        <Progress
          value={(totalSize / STORAGE_QUOTA_BYTES) * 100}
          max={100}
        />
      </div>
      <div className="rounded-lg border text-card-foreground">
        <List data={files} lang={lang} />
      </div>
    </div>
  );
}
