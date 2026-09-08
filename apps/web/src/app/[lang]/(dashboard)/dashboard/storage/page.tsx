import { authOrSignIn } from "@/lib/auth-guard";
import { parseStorageListingParams } from "@beutl/core";
import {
  countFilesByUserId,
  getDb,
  resolveStorageQuota,
  sumFileSizeByUserId,
} from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { retrieveFilesPage, retrieveFolders } from "./actions";
import { List } from "./list";
import { StorageUsage } from "./usage";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ lang }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);

  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const userId = session.user.id;
  const prisma = await getDb();
  // The folder tree is small and the screen needs all of it (breadcrumbs,
  // moving, the location of search results); files come one page at a time,
  // as the URL asks. A folder the user does not have is read as the root.
  const folders = await retrieveFolders();
  const requested = parseStorageListingParams(searchParams);
  const listing = {
    ...requested,
    folderId:
      requested.folderId !== null &&
      folders.some((folder) => folder.id === requested.folderId)
        ? requested.folderId
        : null,
  };
  // The usage line is summed in the database; the upload paths also count
  // reservations of uploads in flight, so the bar can refuse a little before
  // it reads 100%.
  const [page, quota, usedBytes, fileCount] = await Promise.all([
    retrieveFilesPage(listing),
    resolveStorageQuota({ userId, prisma }),
    sumFileSizeByUserId({ userId, prisma }),
    countFilesByUserId({ userId, prisma }),
  ]);

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
      <List
        files={page.files}
        total={page.total}
        page={page.page}
        pageCount={page.pageCount}
        listing={listing}
        folders={folders}
        totalFiles={fileCount}
        lang={lang}
        userId={userId}
      />
    </div>
  );
}
