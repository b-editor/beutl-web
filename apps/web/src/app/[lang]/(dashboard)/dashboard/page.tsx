import { authOrSignIn } from "@/lib/auth-guard";
import { formatBytes, formatCount } from "@beutl/core";
import { Badge } from "@beutl/ui/ui/badge";
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
  const { libraryPackages, storageUsedBytes, storageQuota, entitlements } =
    await retrieveDashboardOverview(session.user.id);

  // File.size は BigInt。上限は最大でも 1TiB = 2^40 なので Number 化しても精度は落ちない。
  const usedBytes = Number(storageUsedBytes);
  const storageRatio = usedBytes / storageQuota.quotaBytes;
  // 無料枠で残りが 1 割を切ったら、加入の導線を出す。
  const storageLevel =
    storageRatio >= 1 ? "full" : storageRatio >= 0.9 ? "warning" : "ok";
  const showStorageUpgrade = storageQuota.tier === null && storageLevel !== "ok";
  // entitlements が null なのは残高を読めなかったときだけ。数値は出さず、
  // AI のページ側で実際の状態を出す。
  const usagePercent = entitlements?.balance.monthlyUsage.usedPercent ?? 0;
  const remainingPercent =
    entitlements?.balance.monthlyUsage.remainingPercent ?? 0;
  const isActive = entitlements?.canUseAi ?? false;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold">
        {t("dashboard:overview.greeting", {
          name: session.user?.name ?? session.user?.email,
        })}
      </h1>

      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
        {/* リンクの入れ子はできないので、カードは div にして中のリンクを分ける。 */}
        <div className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground md:min-w-[320px]">
          <Link
            href={`/${lang}/dashboard/storage`}
            prefetch={false}
            className="flex flex-col gap-3 rounded-md transition-colors hover:text-foreground/80"
          >
            <div className="flex items-center gap-4">
              <HardDrive className="h-8 w-8 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-2xl font-bold">
                    {formatBytes(usedBytes)}
                  </div>
                  {storageQuota.tier !== null && (
                    <Badge variant="secondary">
                      {t(`storage:plan.tier.${storageQuota.tier}`)}
                    </Badge>
                  )}
                </div>
                <div className="truncate text-sm text-muted-foreground">
                  {t("dashboard:overview.storageUsage")}
                  <span aria-hidden> · </span>
                  {t("dashboard:overview.storageQuota", {
                    used: formatBytes(usedBytes),
                    quota: formatBytes(storageQuota.quotaBytes),
                  })}
                </div>
              </div>
            </div>
            <Progress value={Math.min(storageRatio, 1) * 100} max={100} />
          </Link>
          {showStorageUpgrade && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span
                className={
                  storageLevel === "full"
                    ? "text-destructive"
                    : "text-amber-700 dark:text-amber-400"
                }
              >
                {t(
                  storageLevel === "full"
                    ? "dashboard:overview.storageFull"
                    : "dashboard:overview.storageAlmostFull",
                )}
              </span>
              <Link
                href={`/${lang}/dashboard/account/billing`}
                prefetch={false}
                className="font-medium text-primary hover:underline"
              >
                {t("storage:upgrade")}
              </Link>
            </div>
          )}
        </div>

        <Link
          href={
            isActive || entitlements === null
              ? `/${lang}/dashboard/ai`
              : `/${lang}/dashboard/account/billing`
          }
          prefetch={false}
          className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50 md:min-w-[320px]"
        >
          <div className="flex items-center gap-4">
            <Sparkles className="h-8 w-8 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-2xl font-bold">
                {entitlements === null
                  ? "—"
                  : isActive
                    ? `${usagePercent}%`
                    : t("dashboard:overview.aiNotSubscribed")}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {t("dashboard:overview.aiUsage")}
              </div>
            </div>
          </div>
          {entitlements === null ? null : isActive ? (
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
                  {formatCount(entitlements.balance.additionalCredits, lang)}
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
            prefetch={false}
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
              prefetch={false}
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
