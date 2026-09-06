import "server-only";
import {
  countActiveProSubscriptions,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getDb,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  listUserLabels,
} from "@beutl/db";
import { loadAiSettings, PRO_PLAN } from "@beutl/api";
import { aiUsageRangeStart, type AiUsageRange } from "@/lib/ai-usage-range";
import {
  summarizeAiUsageDistribution,
  USAGE_DISTRIBUTION_SCAN_LIMIT,
} from "@/lib/ai-usage-distribution";

export const TOP_USER_LIMIT = 10;

export type AiUsageReportUser = {
  userId: string;
  name: string | null;
  email: string | null;
  jobCount: number;
  reservedUnits: number;
};

export async function getAiUsageReport({
  range,
  now,
}: {
  range: AiUsageRange;
  now: Date;
}) {
  const since = aiUsageRangeStart(range, now);
  // Explicitly share the render-scoped client across the entire report.
  const prisma = await getDb();

  const [
    statusCounts,
    kindUsage,
    totals,
    creditAdjustments,
    balances,
    activeSubscriptions,
    topJobUsers,
    settings,
    accountUsage,
  ] = await Promise.all([
    getAiJobStatusCounts({ since, prisma }),
    getAiJobUsageByKind({ since, prisma }),
    getAiUsageTotals({ since, prisma }),
    getAdminCreditAdjustmentTotals({ since, prisma }),
    getAiBalanceTotals({ now, prisma }),
    countActiveProSubscriptions({ now, planId: PRO_PLAN.id, prisma }),
    getTopAiUsers({ since, limit: TOP_USER_LIMIT, prisma }),
    loadAiSettings({ prisma }),
    listCreditAccountUsageSnapshot({
      limit: USAGE_DISTRIBUTION_SCAN_LIMIT,
      prisma,
    }),
  ]);

  const labels = new Map(
    (
      await listUserLabels({
        userIds: topJobUsers.map((user) => user.userId),
        prisma,
      })
    ).map((user) => [user.id, user]),
  );
  // A deleted account cascades its jobs away, so a missing label means the row
  // was removed between the aggregate and this lookup. Keep the numbers.
  const topUsers: AiUsageReportUser[] = topJobUsers.map((user) => ({
    userId: user.userId,
    name: labels.get(user.userId)?.name ?? null,
    email: labels.get(user.userId)?.email ?? null,
    jobCount: user.jobCount,
    reservedUnits: user.reservedUnits,
  }));

  const jobCount = statusCounts.reduce((total, row) => total + row.jobCount, 0);
  const monthlyUsageLimit = settings.getMonthlyUsageLimit();

  return {
    since,
    jobCount,
    statusCounts,
    kindUsage,
    totals,
    creditAdjustments,
    balances,
    activeSubscriptions,
    topUsers,
    monthlyUsageLimit,
    scanLimit: USAGE_DISTRIBUTION_SCAN_LIMIT,
    // The distribution is a snapshot of the current billing period and does not
    // move with the selected window.
    distribution: summarizeAiUsageDistribution({
      rows: accountUsage,
      monthlyUsageLimit,
      now,
      scanLimit: USAGE_DISTRIBUTION_SCAN_LIMIT,
    }),
  };
}
