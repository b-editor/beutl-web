import {
  findCreditAccount,
  getDb,
  getSubscriptionByUserId,
  listRecentAiJobsByUserId,
  listRecentCreditTransactionsByUserId,
} from "@beutl/db";
import {
  getMonthlyUsageRemaining,
  isActiveProSubscription,
  loadAiSettings,
  toAiBalanceSnapshot,
  toUsedPercent,
} from "@beutl/api";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Progress } from "@beutl/ui/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import {
  formatNumber,
  formatSignedNumber,
  formatTimestamp,
} from "@/lib/format";
import { AiPlanAdjustmentForm } from "./ai-plan-form";

const RECENT_LIMIT = 10;

export async function AiPlanSection({
  lang,
  userId,
}: {
  lang: string;
  userId: string;
}) {
  const { t } = await getTranslation(lang);
  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // このセクションのクエリで 1 つのクライアントを共有する。
  const prisma = await getDb();
  const [account, subscription, jobs, transactions, settings] =
    await Promise.all([
      findCreditAccount({ userId, prisma }),
      getSubscriptionByUserId({ userId, prisma }),
      listRecentAiJobsByUserId({ userId, limit: RECENT_LIMIT, prisma }),
      listRecentCreditTransactionsByUserId({
        userId,
        limit: RECENT_LIMIT,
        prisma,
      }),
      loadAiSettings({ prisma }),
    ]);

  const isActive = isActiveProSubscription(subscription);
  const monthlyUsageLimit = isActive ? settings.getMonthlyUsageLimit() : 0;
  const balance = toAiBalanceSnapshot(
    account ?? {
      monthlyUsageUsed: 0,
      purchasedCredits: 0,
      purchasedCreditDebt: 0,
    },
    monthlyUsageLimit,
  );
  const usedPercent = toUsedPercent(
    balance.monthlyUsage.used,
    balance.monthlyUsage.limit,
  );
  // toAiBalanceSnapshot は利用者向けに消費量を割当まで丸める。管理画面が出すのは
  // 実際に保存されている値: 割当を下げた後は保存値が割当を超えることがあり、
  // 丸めた値を出すと、下の調整フォームが「見えていない差分」を書き戻してしまう。
  const storedMonthlyUsageUsed = account?.monthlyUsageUsed ?? 0;

  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t("admin:users.aiPlan")}</h2>
        <Badge variant={isActive ? "default" : "outline"}>
          {t(isActive ? "admin:users.aiPlanActive" : "admin:users.aiPlanNone")}
        </Badge>
        {subscription?.status && (
          <code className="text-xs text-muted-foreground">
            {subscription.status}
          </code>
        )}
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">
            {t("admin:users.aiMonthlyUsage")}
          </dt>
          <dd className="mt-1 flex flex-col gap-1">
            <span className="font-medium">
              {t("admin:users.aiMonthlyUsageValue", {
                used: formatNumber(storedMonthlyUsageUsed, lang),
                limit: formatNumber(balance.monthlyUsage.limit, lang),
                remaining: formatNumber(
                  getMonthlyUsageRemaining(balance),
                  lang,
                ),
              })}
            </span>
            <Progress value={usedPercent} className="h-2 max-w-md" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiPurchasedCredits")}
          </dt>
          <dd className="font-medium">
            {formatNumber(balance.additionalCredits, lang)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiCreditDebt")}
          </dt>
          <dd className="font-medium">
            {formatNumber(balance.additionalCreditDebt, lang)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiUsagePeriod")}
          </dt>
          <dd>
            {account?.usagePeriodStart && account.usagePeriodEnd
              ? `${formatTimestamp(account.usagePeriodStart, lang)} – ${formatTimestamp(account.usagePeriodEnd, lang)}`
              : "-"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiSubscriptionPeriod")}
          </dt>
          <dd>
            {subscription?.currentPeriodEnd
              ? formatTimestamp(subscription.currentPeriodEnd, lang)
              : "-"}
          </dd>
        </div>
      </dl>

      <div className="mt-6 border-t pt-6">
        <AiPlanAdjustmentForm
          lang={lang}
          userId={userId}
          canAdjustMonthlyUsage={isActive}
          monthlyUsageUsed={storedMonthlyUsageUsed}
          monthlyUsageLimit={balance.monthlyUsage.limit}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            {t("admin:users.aiRecentJobs")}
          </h3>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("admin:common.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:ai.usage.kind")}</TableHead>
                  <TableHead>{t("admin:ai.usage.status")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin:ai.usage.reservedUnits")}
                  </TableHead>
                  <TableHead>{t("admin:auditLog.createdAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      {t(`admin:ai.usage.jobKind.${job.kind}`, {
                        defaultValue: job.kind,
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {job.status}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(job.usageUnits, lang)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTimestamp(job.createdAt, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">
            {t("admin:users.aiRecentTransactions")}
          </h3>
          {transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("admin:common.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:users.aiTransactionKind")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin:users.aiTransactionCredit")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("admin:users.aiTransactionUsage")}
                  </TableHead>
                  <TableHead>{t("admin:auditLog.createdAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((transaction) => (
                  <TableRow key={transaction.id}>
                    <TableCell>
                      {t(
                        `admin:users.aiTransactionKinds.${transaction.kind}`,
                        { defaultValue: transaction.kind },
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatSignedNumber(transaction.creditAmount, lang)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatSignedNumber(transaction.usageAmount, lang)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTimestamp(transaction.createdAt, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </section>
  );
}
