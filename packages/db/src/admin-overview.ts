import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// 管理者の対応待ちになっている行の件数。ダッシュボードで各キューを開かずに
// 滞留を把握するためのもので、各一覧ページの条件と揃えている。
export async function countAdminInterventions({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? await getDb();
  const [topUp, packagePaymentRefund, storageMultipart, storageUpload] = await Promise.all([
    db.topUpCheckoutResolution.count({ where: { status: "intervention" } }),
    db.packagePaymentRefundAttempt.count({ where: { status: "intervention" } }),
    db.storageMultipartCleanup.count({ where: { status: "intervention" } }),
    db.storageUpload.count({
      where: { completionState: { in: ["intervention", "unknown"] } },
    }),
  ]);
  return { topUp, packagePaymentRefund, storageMultipart, storageUpload };
}

// Stripe の status が active で、期間末がまだ来ていない契約をプランごとに数える。
// hold や cancelAt による権利の停止は含めていないため、権利判定の件数とは一致しない。
export async function countActiveSubscriptionsByPlan({
  now = new Date(),
  prisma,
}: {
  now?: Date;
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? await getDb();
  const rows = await db.subscription.groupBy({
    by: ["planId"],
    where: { status: "active", currentPeriodEnd: { gt: now } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row.planId, row._count._all])) as Record<string, number>;
}

export async function listSubscriptionsForAdmin({
  planId,
  status,
  currentOnly = false,
  now = new Date(),
  page,
  pageSize,
  prisma,
}: {
  planId?: string;
  status?: string;
  // countActiveSubscriptionsByPlan と同じく、期間末を過ぎた行を除く。
  currentOnly?: boolean;
  now?: Date;
  page: number;
  pageSize: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const where = {
    planId,
    status,
    ...(currentOnly ? { currentPeriodEnd: { gt: now } } : {}),
  };
  const [items, total] = await Promise.all([
    db.subscription.findMany({
      where,
      select: {
        userId: true,
        planId: true,
        tier: true,
        status: true,
        stripeSubscriptionId: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
        updatedAt: true,
        user: { select: { name: true, email: true } },
      },
      // 同時刻の行でページ境界が揺れないよう、主キーで順序を確定させる。
      orderBy: [{ updatedAt: "desc" }, { userId: "asc" }, { planId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.subscription.count({ where }),
  ]);
  return { items, total };
}
