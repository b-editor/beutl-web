import { authOrSignIn } from "@/lib/auth-guard";
import { getTranslation } from "@beutl/i18n";
import { retrieveFiles, retrieveFolders } from "./actions";
import { List } from "./list";
import { StorageUsage } from "./usage";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;

  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const [files, folders] = await Promise.all([retrieveFiles(), retrieveFolders()]);
  let usedBytes = 0;
  for (const file of files) {
    usedBytes += Number(file.size);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{t("storage:storage")}</h1>
        <StorageUsage lang={lang} usedBytes={usedBytes} fileCount={files.length} />
      </div>
      <List
        data={files}
        folders={folders}
        lang={lang}
        userId={session.user.id}
      />
    </div>
  );
}
