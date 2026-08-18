// Read-only aggregates behind the admin console's AI usage view.
//
// Nothing here upserts or mutates: an operator opening a report must not create
// rows. User-facing labels are resolved by the caller, so these queries stay
// usable from any app that only has an account id.
import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// Ledger kinds that represent actual consumption. A usage row stores the
// monthly share in usageAmount and the purchased share as a negative
// creditAmount; a refund row stores the mirror image. Net units consumed is
// therefore sum(usageAmount) - sum(creditAmount) across both kinds.
const CONSUMPTION_KINDS = ["usage", "refund"] as const;

// A purchase row carries the credits bought; a reversal row carries the credits
// taken back by a refund or dispute as a negative amount, and a later restore as
// a positive one. Summing both yields what was actually paid for and kept.
const PURCHASE_KINDS = ["purchase", "purchase_reversal"] as const;

export type AiJobStatusCount = {
  status: string;
  jobCount: number;
};

export type AiJobKindUsage = {
  kind: string;
  jobCount: number;
  reservedUnits: number;
};

export type AiUsageTotals = {
  consumedUnits: number;
  purchasedCredits: number;
  adminUsageAdjustment: number;
};

export type AiBalanceTotals = {
  accountCount: number;
  monthlyUsageUsed: number;
  purchasedCredits: number;
  purchasedCreditDebt: number;
};

export type AiTopUser = {
  userId: string;
  jobCount: number;
  reservedUnits: number;
};

function sumOf(value: number | null | undefined): number {
  return value ?? 0;
}

export async function getAiJobStatusCounts({
  since,
  prisma,
}: {
  since: Date;
  prisma?: PrismaTransaction;
}): Promise<AiJobStatusCount[]> {
  const db = prisma ?? await getDb();
  const rows = await db.aiJob.groupBy({
    by: ["status"],
    where: {
      createdAt: {
        gte: since,
      },
    },
    _count: {
      _all: true,
    },
  });
  return rows
    .map((row) => ({
      status: row.status,
      jobCount: row._count._all,
    }))
    .sort((left, right) => right.jobCount - left.jobCount);
}

// Reserved units are what each job charged when it started. Failed jobs keep
// their reservation here even after a refund, so this answers "what was asked
// for" while getAiUsageTotals answers "what was actually paid".
export async function getAiJobUsageByKind({
  since,
  prisma,
}: {
  since: Date;
  prisma?: PrismaTransaction;
}): Promise<AiJobKindUsage[]> {
  const db = prisma ?? await getDb();
  const rows = await db.aiJob.groupBy({
    by: ["kind"],
    where: {
      createdAt: {
        gte: since,
      },
    },
    _count: {
      _all: true,
    },
    _sum: {
      usageUnits: true,
    },
  });
  return rows
    .map((row) => ({
      kind: row.kind,
      jobCount: row._count._all,
      reservedUnits: sumOf(row._sum.usageUnits),
    }))
    .sort((left, right) => right.reservedUnits - left.reservedUnits);
}

export async function getAiUsageTotals({
  since,
  prisma,
}: {
  since: Date;
  prisma?: PrismaTransaction;
}): Promise<AiUsageTotals> {
  const db = prisma ?? await getDb();
  const rows = await db.creditTransaction.groupBy({
    by: ["kind"],
    where: {
      createdAt: {
        gte: since,
      },
    },
    _sum: {
      usageAmount: true,
      creditAmount: true,
    },
  });

  const totals: AiUsageTotals = {
    consumedUnits: 0,
    purchasedCredits: 0,
    adminUsageAdjustment: 0,
  };
  for (const row of rows) {
    const usageAmount = sumOf(row._sum.usageAmount);
    const creditAmount = sumOf(row._sum.creditAmount);
    if ((CONSUMPTION_KINDS as readonly string[]).includes(row.kind)) {
      totals.consumedUnits += usageAmount - creditAmount;
      continue;
    }
    if ((PURCHASE_KINDS as readonly string[]).includes(row.kind)) {
      totals.purchasedCredits += creditAmount;
      continue;
    }
    if (row.kind === "admin_usage_adjustment") {
      totals.adminUsageAdjustment += usageAmount;
    }
  }
  return totals;
}

// Grants and revokes cancel out inside one group, so count them per row.
export async function getAdminCreditAdjustmentTotals({
  since,
  prisma,
}: {
  since: Date;
  prisma?: PrismaTransaction;
}): Promise<{ granted: number; revoked: number }> {
  const db = prisma ?? await getDb();
  const rows = await db.creditTransaction.findMany({
    where: {
      kind: "admin_credit_adjustment",
      createdAt: {
        gte: since,
      },
    },
    select: {
      creditAmount: true,
    },
  });
  let granted = 0;
  let revoked = 0;
  for (const row of rows) {
    if (row.creditAmount > 0) {
      granted += row.creditAmount;
    } else {
      revoked += -row.creditAmount;
    }
  }
  return { granted, revoked };
}

export async function getAiBalanceTotals({
  now,
  prisma,
}: {
  now: Date;
  prisma?: PrismaTransaction;
}): Promise<AiBalanceTotals> {
  const db = prisma ?? await getDb();
  // Purchased credits and debt belong to no billing period, so they are counted
  // over every account. The monthly counter does belong to one, and it is only
  // cleared when the account next spends: a lapsed subscriber's row still holds
  // the total from the period they left in, forever. Summing those reports
  // consumption that is not happening, beside a distribution panel that
  // excludes the same rows for the same reason.
  const [overall, currentPeriod] = await Promise.all([
    db.creditAccount.aggregate({
      _count: {
        _all: true,
      },
      _sum: {
        purchasedCredits: true,
        purchasedCreditDebt: true,
      },
    }),
    db.creditAccount.aggregate({
      _sum: {
        monthlyUsageUsed: true,
      },
      where: {
        usagePeriodEnd: {
          gt: now,
        },
      },
    }),
  ]);
  return {
    accountCount: overall._count._all,
    monthlyUsageUsed: sumOf(currentPeriod._sum.monthlyUsageUsed),
    purchasedCredits: sumOf(overall._sum.purchasedCredits),
    purchasedCreditDebt: sumOf(overall._sum.purchasedCreditDebt),
  };
}

export async function getTopAiUsers({
  since,
  limit,
  prisma,
}: {
  since: Date;
  limit: number;
  prisma?: PrismaTransaction;
}): Promise<AiTopUser[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  const db = prisma ?? await getDb();
  const rows = await db.aiJob.groupBy({
    by: ["userId"],
    where: {
      createdAt: {
        gte: since,
      },
    },
    _count: {
      _all: true,
    },
    _sum: {
      usageUnits: true,
    },
    orderBy: {
      _sum: {
        usageUnits: "desc",
      },
    },
    take: limit,
  });
  return rows.map((row) => ({
    userId: row.userId,
    jobCount: row._count._all,
    reservedUnits: sumOf(row._sum.usageUnits),
  }));
}

// The plan id is a parameter because the catalog that names it lives in
// @beutl/api, which depends on this package.
export async function countActiveProSubscriptions({
  now,
  planId,
  prisma,
}: {
  now: Date;
  planId: string;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? await getDb();
  return await db.subscription.count({
    where: {
      status: "active",
      planId,
      // A row with no offer was never matched to a Price and is granted
      // nothing, the same way isActiveProSubscription reads it.
      billingOfferId: {
        not: null,
      },
      currentPeriodEnd: {
        gt: now,
      },
      // A subscription cancelled mid-period stops being entitled at cancelAt,
      // not at the end of the period it was paid through; counting by
      // currentPeriodEnd alone reports it as spending against the allowance
      // for weeks after it stopped being able to.
      OR: [{ cancelAt: null }, { cancelAt: { gt: now } }],
    },
  });
}

// The account row as stored. Unlike getCreditAccount this never creates one,
// because opening an admin page must not write to the ledger.
export async function findCreditAccount({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.creditAccount.findUnique({
    where: {
      userId,
    },
  });
}

export type CreditAccountUsageSnapshot = {
  monthlyUsageUsed: number;
  purchasedCredits: number;
  purchasedCreditDebt: number;
  usagePeriodStart: Date | null;
  usagePeriodEnd: Date | null;
};

// Every account's current-period consumption, for judging whether the monthly
// allowance is set sensibly. userId is deliberately not selected: this feeds an
// aggregate report, and naming an account there serves no purpose.
//
// One row more than the limit is fetched so the caller can tell a full result
// from a truncated one. Quantiles are computed by the caller rather than in
// SQL, because CreditAccount is indexed only by its primary key — a filtered
// query would scan the whole table anyway — and a raw percentile query could
// not run against the in-memory Prisma used by the contract tests.
export async function listCreditAccountUsageSnapshot({
  limit,
  prisma,
}: {
  limit: number;
  prisma?: PrismaTransaction;
}): Promise<CreditAccountUsageSnapshot[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  const db = prisma ?? await getDb();
  return await db.creditAccount.findMany({
    select: {
      monthlyUsageUsed: true,
      purchasedCredits: true,
      purchasedCreditDebt: true,
      usagePeriodStart: true,
      usagePeriodEnd: true,
    },
    orderBy: {
      userId: "asc",
    },
    take: limit + 1,
  });
}

export async function listRecentAiJobsByUserId({
  userId,
  limit,
  prisma,
}: {
  userId: string;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  const db = prisma ?? await getDb();
  return await db.aiJob.findMany({
    where: {
      userId,
    },
    select: {
      id: true,
      kind: true,
      status: true,
      usageUnits: true,
      deletedAt: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

export async function listRecentCreditTransactionsByUserId({
  userId,
  limit,
  prisma,
}: {
  userId: string;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }
  const db = prisma ?? await getDb();
  return await db.creditTransaction.findMany({
    where: {
      userId,
    },
    select: {
      id: true,
      kind: true,
      creditAmount: true,
      debtAmount: true,
      usageAmount: true,
      aiJobId: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}
