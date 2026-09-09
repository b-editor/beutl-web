import {
  countFilesByUserId,
  getDb,
  resolveStorageQuota,
  sumFileSizeByUserId,
} from "@beutl/db";
import { effectiveSubscriptionEnd, formatBytes, isStorageTierId } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Progress } from "@beutl/ui/ui/progress";
import { formatNumber, formatTimestamp } from "@/lib/format";

// ストレージプランの契約と使用量。AI Pro とは別の契約なので別の節に出す。
// 容量の判定はユーザー向けと同じ resolveStorageQuota を読む。
export async function StoragePlanSection({
  lang,
  userId,
}: {
  lang: string;
  userId: string;
}) {
  const { t } = await getTranslation(lang);
  const prisma = await getDb();
  const [quota, usedBytes, fileCount] = await Promise.all([
    resolveStorageQuota({ userId, prisma }),
    sumFileSizeByUserId({ userId, prisma }),
    countFilesByUserId({ userId, prisma }),
  ]);
  const used = Number(usedBytes);
  const subscription = quota.subscription;
  // The tier the customer subscribed to, whether or not it grants anything
  // right now (past_due, a refund hold); the effective quota below is what is
  // enforced and may have fallen back to free.
  const subscribedTier = isStorageTierId(subscription?.tier) ? subscription!.tier : null;
  const entitled = quota.tier !== null;
  const periodEnd = subscription ? effectiveSubscriptionEnd(subscription) : null;
  const usedPercent = Math.min(
    100,
    Math.round((used / quota.quotaBytes) * 100),
  );

  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t("admin:storage.plan")}</h2>
        <Badge variant={entitled ? "default" : "outline"}>
          {subscribedTier
            ? t(`admin:storage.tiers.${subscribedTier}`)
            : t("admin:storage.free")}
        </Badge>
        {subscription?.status && (
          <code className="text-xs text-muted-foreground">
            {subscription.status}
          </code>
        )}
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t("admin:storage.usage")}</dt>
          <dd className="mt-1 flex flex-col gap-1">
            <span className="font-medium">
              {t("admin:storage.usageValue", {
                used: formatBytes(used),
                quota: formatBytes(quota.quotaBytes),
                files: formatNumber(fileCount, lang),
                limit: formatNumber(quota.fileCountLimit, lang),
              })}
            </span>
            <Progress value={usedPercent} className="h-2 max-w-md" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("admin:storage.status")}</dt>
          <dd className="font-medium">
            {t(
              entitled
                ? "admin:storage.planActive"
                : subscribedTier
                  ? "admin:storage.planHeld"
                  : "admin:storage.planNone",
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:storage.subscriptionPeriod")}
          </dt>
          <dd>{periodEnd ? formatTimestamp(periodEnd, lang) : "-"}</dd>
        </div>
      </dl>
    </section>
  );
}
