import { authOrSignIn } from "@/lib/auth-guard";
import { formatBytes, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Progress } from "@beutl/ui/ui/progress";
import { HardDrive, Sparkles } from "lucide-react";
import Link from "next/link";
import { LibraryPackageCard } from "./library/package-card";
import { retrieveDashboardOverview } from "./queries";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { libraryPackages, storageUsedBytes, entitlements } =
    await retrieveDashboardOverview(session.user.id);

  // File.size は BigInt。1GB 上限なので Number 化しても精度は落ちない。
  const usedBytes = Number(storageUsedBytes);
  const usagePercent = entitlements.balance.monthlyUsage.usedPercent;
  const remainingPercent = entitlements.balance.monthlyUsage.remainingPercent;
  const isActive = entitlements.canUseAi;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold">
        {t("dashboard:overview.greeting", {
          name: session.user?.name ?? session.user?.email,
        })}
      </h1>

      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
        <Link
          href={`/${lang}/dashboard/storage`}
          className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50 md:min-w-[320px]"
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

        <Link
          href={
            isActive
              ? `/${lang}/dashboard/ai`
              : `/${lang}/dashboard/account/billing`
          }
          className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50 md:min-w-[320px]"
        >
          <div className="flex items-center gap-4">
            <Sparkles className="h-8 w-8 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-2xl font-bold">
                {isActive ? `${usagePercent}%` : t("dashboard:overview.aiNotSubscribed")}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {t("dashboard:overview.aiUsage")}
              </div>
            </div>
          </div>
          {isActive ? (
            <>
              <Progress value={usagePercent} max={100} />
              <p className="text-sm text-muted-foreground">
                {t("account:aiPlan.monthlyUsageHint", {
                  percent: remainingPercent,
                })}
              </p>
              {entitlements.balance.additionalCredits > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("account:aiPlan.additionalCredits")}:{" "}
                  {entitlements.balance.additionalCredits.toLocaleString(
                    lang === "ja" ? "ja-JP" : "en-US",
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("dashboard:overview.aiJoinPro")}
            </p>
          )}
        </Link>
      </div>

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
            {libraryPackages.map((item) => (
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
