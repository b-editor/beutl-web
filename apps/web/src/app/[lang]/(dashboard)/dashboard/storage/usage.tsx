import { Progress } from "@beutl/ui/ui/progress";
import { Badge } from "@beutl/ui/ui/badge";
import { cn, formatBytes, type StorageQuota } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import Link from "next/link";

// 残りが 1 割を切ったら警告し、使い切ったら赤にする。
const WARNING_RATIO = 0.9;

// 一覧の脇に添える一行。数字を大きく見せる場所ではないので、細いバーと小さな
// 説明文だけにし、空きが少ないときだけ色と一文で目を引く。無料枠の人には
// プランへの導線を添える。
export async function StorageUsage({
  lang,
  usedBytes,
  fileCount,
  quota,
}: {
  lang: string;
  usedBytes: number;
  fileCount: number;
  quota: StorageQuota;
}) {
  const { t } = await getTranslation(lang);
  const ratio = Math.min(usedBytes / quota.quotaBytes, 1);
  const remainingBytes = Math.max(quota.quotaBytes - usedBytes, 0);
  // over は失効後に無料枠を超えている状態。full と同じ色だが文言が違う。
  const level =
    usedBytes > quota.quotaBytes && quota.tier === null
      ? "over"
      : ratio >= 1
        ? "full"
        : ratio >= WARNING_RATIO
          ? "warning"
          : "ok";
  const usage = t("storage:storageUsage", {
    used: formatBytes(usedBytes),
    quota: formatBytes(quota.quotaBytes),
  });
  const billingHref = `/${lang}/dashboard/account/billing`;
  const upgradeLink = (
    <Link
      href={billingHref}
      prefetch={false}
      className="font-medium text-primary hover:underline"
    >
      {t(quota.tier === null ? "storage:upgrade" : "storage:changePlan")}
    </Link>
  );

  return (
    <div className="flex flex-col gap-1.5" aria-label={usage}>
      <Progress
        value={ratio * 100}
        max={100}
        className={cn(
          "h-1.5 max-w-xs",
          level === "warning" && "[&>div]:bg-amber-500",
          (level === "full" || level === "over") && "[&>div]:bg-destructive",
        )}
      />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <Badge variant="secondary" className="font-normal">
          {t(
            quota.tier === null
              ? "storage:plan.free"
              : `storage:plan.tier.${quota.tier}`,
          )}
        </Badge>
        <span>{usage}</span>
        <span aria-hidden>·</span>
        <span>
          {t("storage:fileCountOfLimit", {
            count: fileCount,
            limit: quota.fileCountLimit,
          })}
        </span>
        {level === "ok" && quota.tier === null && (
          <>
            <span aria-hidden>·</span>
            {upgradeLink}
          </>
        )}
      </p>
      {level !== "ok" && (
        <p
          className={cn(
            "text-xs",
            level === "warning"
              ? "text-amber-700 dark:text-amber-400"
              : "text-destructive",
          )}
        >
          {level === "over"
            ? t("storage:overFreeQuota")
            : level === "full"
              ? t(quota.tier === null ? "storage:full" : "storage:fullSubscribed")
              : t("storage:almostFull")}
          {level === "warning" && (
            <>
              <span aria-hidden> </span>
              {t("storage:remaining", { remaining: formatBytes(remainingBytes) })}
            </>
          )}
          <span aria-hidden> </span>
          {upgradeLink}
        </p>
      )}
    </div>
  );
}
