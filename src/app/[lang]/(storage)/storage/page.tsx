import { Progress } from "@/components/ui/progress";
import { authOrSignIn } from "@/lib/auth-guard";
import { formatBytes } from "@/lib/utils";
import { retrieveFiles } from "./actions";
import { List } from "./list";
import { getTranslation } from "@/app/i18n/server";

export default async function Page({ params: { lang } }: { params: { lang: string } }) {
  await authOrSignIn();
  const { t } = await getTranslation(lang);
  const files = await retrieveFiles();
  let totalSize = 0;
  for (const file of files) {
    totalSize += Number(file.size);
  }

  return (

    <div>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col gap-12">
          <h2 className="text-3xl font-semibold">{t("storage:storage")}</h2>
          <div className="flex gap-2 flex-col">
            <p>{t("storage:storageUsage", { totalSize: formatBytes(totalSize) })}</p>
            <Progress value={(totalSize / (1024 * 1024 * 1024)) * 100} max={100} />
          </div>
        </div>
      </div>
      <div className="container max-w-6xl mx-auto">
        <div className="mt-4 rounded-lg border text-card-foreground">
          <List data={files} lang={lang} />
        </div>
      </div>
    </div>
  )
}