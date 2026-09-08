import { authOrSignIn } from "@/lib/auth-guard";
import {
  countFilesByUserId,
  getDb,
  resolveStorageQuota,
  sumFileSizeByUserId,
} from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { Alert, AlertDescription } from "@beutl/ui/ui/alert";
import { Info } from "lucide-react";
import { retrieveFiles, retrieveFolders } from "./actions";
import { List } from "./list";
import { StorageUsage } from "./usage";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;

  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const userId = session.user.id;
  const prisma = await getDb();
  // The listing is bounded (the newest STORAGE_LIST_MAX_FILES), so the usage
  // line is summed in the database rather than over what happens to be on the
  // page. The upload paths also count reservations of uploads in flight, so
  // the bar can refuse a little before it reads 100%.
  const [files, folders, quota, usedBytes, fileCount] = await Promise.all([
    retrieveFiles(),
    retrieveFolders(),
    resolveStorageQuota({ userId, prisma }),
    sumFileSizeByUserId({ userId, prisma }),
    countFilesByUserId({ userId, prisma }),
  ]);
  const truncated = fileCount > files.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{t("storage:storage")}</h1>
        <StorageUsage
          lang={lang}
          usedBytes={Number(usedBytes)}
          fileCount={fileCount}
          quota={quota}
        />
      </div>
      {truncated && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            {t("storage:listTruncated", {
              shown: files.length,
              total: fileCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      <List
        data={files}
        folders={folders}
        lang={lang}
        userId={session.user.id}
      />
    </div>
  );
}
