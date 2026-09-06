import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  countActiveProSubscriptions,
  findCheckoutBillingOffer,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  setDbProvider,
} from "@beutl/db";

// The admin usage report leans on groupBy with _count/_sum and an aggregate
// orderBy, which the in-memory stub can only approximate. This exercises the
// real SQL against CockroachDB. It reads only, so it makes no assumption about
// what the target database contains.
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("AI usage aggregates on CockroachDB", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const adapter = new PrismaPg({ connectionString: connectionString! });
    prisma = new PrismaClient({ adapter });
    setDbProvider(async () => prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs every report query the admin console issues", async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [statusCounts, kindUsage, totals, adjustments, balances, topUsers, subscriptions] =
      await Promise.all([
        getAiJobStatusCounts({ since }),
        getAiJobUsageByKind({ since }),
        getAiUsageTotals({ since }),
        getAdminCreditAdjustmentTotals({ since }),
        getAiBalanceTotals({ now: new Date() }),
        getTopAiUsers({ since, limit: 10 }),
        countActiveProSubscriptions({ now, planId: "pro" }),
      ]);

    expect(Array.isArray(statusCounts)).toBe(true);
    expect(Array.isArray(kindUsage)).toBe(true);
    expect(Array.isArray(topUsers)).toBe(true);
    expect(topUsers.length).toBeLessThanOrEqual(10);
    expect(Number.isSafeInteger(totals.consumedUnits)).toBe(true);
    expect(Number.isSafeInteger(totals.purchasedCredits)).toBe(true);
    expect(Number.isSafeInteger(totals.adminUsageAdjustment)).toBe(true);
    expect(Number.isSafeInteger(adjustments.granted)).toBe(true);
    expect(Number.isSafeInteger(adjustments.revoked)).toBe(true);
    expect(Number.isSafeInteger(balances.accountCount)).toBe(true);
    expect(Number.isSafeInteger(subscriptions)).toBe(true);

    // The ranking must come back sorted by the aggregate, not by insertion.
    const reserved = topUsers.map((user) => user.reservedUnits);
    expect(reserved).toEqual([...reserved].sort((left, right) => right - left));
  });

  it("runs the queries behind the settings page", async () => {
    const [proOffer, topUpOffer, accountUsage] = await Promise.all([
      findCheckoutBillingOffer({ kind: "pro" }),
      findCheckoutBillingOffer({ kind: "top_up" }),
      listCreditAccountUsageSnapshot({ limit: 100 }),
    ]);

    // A development database may have no offer registered at all; the page has
    // to survive that, so only the shape is asserted.
    for (const offer of [proOffer, topUpOffer]) {
      if (offer) {
        expect(offer.checkoutEnabled).toBe(true);
        expect(Number.isSafeInteger(offer.unitAmount)).toBe(true);
        expect(offer.currency).toBe(offer.currency.toLowerCase());
      }
    }

    expect(Array.isArray(accountUsage)).toBe(true);
    for (const row of accountUsage) {
      expect(Number.isSafeInteger(row.monthlyUsageUsed)).toBe(true);
      // The report must not carry an account identifier.
      expect(row).not.toHaveProperty("userId");
    }
  });

  // The reports all open with a range predicate on createdAt, so an index that
  // cannot serve one is useless to them — which is how the first version of
  // these indexes, led by kind, was wrong. Whether the optimizer actually picks
  // the index depends on how much data the target database holds, so this only
  // asserts that a range scan is available at all.
  it("keeps a createdAt-led index on both reported tables", async () => {
    const indexes = await prisma.$queryRawUnsafe<
      { table_name: string; index_name: string; column_name: string }[]
    >(
      `SELECT table_name, index_name, column_name
       FROM information_schema.statistics
       WHERE table_schema = 'public'
         AND table_name IN ('AiJob', 'CreditTransaction')
         AND seq_in_index = 1
         AND column_name = 'createdAt'`,
    );

    expect(
      indexes.map((row) => `${row.table_name}.${row.index_name}`).sort(),
    ).toEqual(
      expect.arrayContaining([
        "AiJob.AiJob_createdAt_idx",
        "CreditTransaction.CreditTransaction_createdAt_idx",
      ]),
    );
  });
});
