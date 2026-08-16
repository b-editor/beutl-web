import { authOrSignIn } from "@/lib/auth-guard";
import { formatBytes, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Progress } from "@beutl/ui/ui/progress";
import { HardDrive } from "lucide-react";
import Link from "next/link";
import { LibraryPackageCard } from "./library/package-card";
import { retrieveDashboardOverview } from "./queries";

// 概要に出すライブラリのパッケージ数。これを超える分は一覧ページで見てもらう。
const LIBRARY_PREVIEW_COUNT = 6;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { libraryPackages, storageUsedBytes } =
    await retrieveDashboardOverview(session.user.id);

  // File.size は BigInt。1GB 上限なので Number 化しても精度は落ちない。
  const usedBytes = Number(storageUsedBytes);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold">
        {t("dashboard:overview.greeting", {
          name: session.user?.name ?? session.user?.email,
        })}
      </h1>

      <Link
        href={`/${lang}/dashboard/storage`}
        className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50"
      >
        <div className="flex items-center gap-4">
          <HardDrive className="h-8 w-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-2xl font-bold">
              {formatBytes(usedBytes)}
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {t("dashboard:overview.storageUsage")}
            </div>
          </div>
        </div>
        <Progress value={(usedBytes / STORAGE_QUOTA_BYTES) * 100} max={100} />
      </Link>

      <div>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">
            {t("dashboard:overview.myLibrary")}
          </h2>
          <Link
            href={`/${lang}/dashboard/library`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("dashboard:overview.viewAll")}
          </Link>
        </div>

        {libraryPackages.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-lg border bg-card p-6 text-card-foreground">
            <p className="text-sm text-muted-foreground">
              {t("dashboard:overview.noLibraryPackages")}
            </p>
            <Link
              href={`/${lang}/store`}
              className="text-sm font-medium text-primary hover:underline"
            >
              {t("dashboard:overview.browseStore")}
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap -mx-2">
            {libraryPackages.slice(0, LIBRARY_PREVIEW_COUNT).map((item) => (
              <LibraryPackageCard
                key={item.id}
                item={item}
                lang={lang}
                freeLabel={t("store:free")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
