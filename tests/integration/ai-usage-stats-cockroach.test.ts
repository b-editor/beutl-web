import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  countActiveSubscriptions,
  findCheckoutBillingOffer,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  listRecentAiJobsByUserId,
  setDbProvider,
} from "@beutl/db";

// The in-memory stub can only approximate the admin report's aggregates and
// ranking. Exercise the real SQL without retaining any fixture data: queries
// are read-only except for the reservation fixtures, which are rolled back.
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

  it("keeps reservations distinct from settled usage in SQL", async () => {
    const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    const [userA, userB, userC] = userIds;
    const rollback = new Error("Roll back reservation report fixtures");

    await expect(prisma.$transaction(async (tx) => {
      const newestJob = await tx.aiJob.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      // Keep report totals independent of existing development data.
      const since = new Date(Math.max(Date.now(), newestJob?.createdAt.getTime() ?? 0) + 60_000);
      await tx.user.createMany({
        data: userIds.map((id) => ({ id, email: `${id}@reservation-test.invalid` })),
      });
      const job = { provider: "test", status: "succeeded", createdAt: since };
      await tx.aiJob.createMany({
        data: [
          { ...job, userId: userA, kind: "image", usageUnits: 0.125, reservedUsageUnits: 3.125, usageSettledAt: since },
          { ...job, userId: userA, kind: "image", usageUnits: 2.25 },
          { ...job, userId: userB, kind: "video", usageUnits: 20, reservedUsageUnits: 5.25, usageSettledAt: since },
          { ...job, userId: userC, kind: "image", usageUnits: 5.125 },
        ],
      });

      expect(await getAiJobUsageByKind({ since, prisma: tx })).toEqual([
        { kind: "image", jobCount: 3, reservedUnits: 10.5 },
        { kind: "video", jobCount: 1, reservedUnits: 5.25 },
      ]);
      expect(await getTopAiUsers({ since, limit: 1, prisma: tx })).toEqual([
        { userId: userA, jobCount: 2, reservedUnits: 5.375 },
      ]);
      const recent = await listRecentAiJobsByUserId({ userId: userA, limit: 10, prisma: tx });
      expect(recent).toEqual(expect.arrayContaining([
        expect.objectContaining({ usageUnits: 0.125, reservedUnits: 3.125 }),
        expect.objectContaining({ usageUnits: 2.25, reservedUnits: 2.25 }),
      ]));
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);

    expect(await prisma.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }, 45_000);

  it.each([0.625, 4.25])("keeps consumption in its job creation window after settling to %s units", async (actual) => {
    const userId = crypto.randomUUID();
    const [oldJob, currentJob, failedJob] = Array.from({ length: 3 }, () => crypto.randomUUID());
    const rollback = new Error("Roll back consumption window fixtures");

    await expect(prisma.$transaction(async (tx) => {
      const [newestJob, newestTransaction] = await Promise.all([
        tx.aiJob.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        tx.creditTransaction.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      ]);
      const before = new Date(Math.max(
        Date.now(), newestJob?.createdAt.getTime() ?? 0, newestTransaction?.createdAt.getTime() ?? 0,
      ) + 60_000);
      const since = new Date(before.getTime() + 1_000);
      const later = new Date(since.getTime() + 1_000);
      await tx.user.create({ data: { id: userId, email: `${userId}@consumption-test.invalid` } });
      await tx.creditAccount.create({ data: { userId } });
      const job = { userId, provider: "test", kind: "image", status: "succeeded" };
      await tx.aiJob.createMany({ data: [
        { ...job, id: oldJob, usageUnits: actual, reservedUsageUnits: 3.125, createdAt: before, usageSettledAt: later },
        { ...job, id: currentJob, usageUnits: 2.25, reservedUsageUnits: 2.5, createdAt: since, usageSettledAt: later, deletedAt: later },
        { ...job, id: failedJob, status: "failed", usageUnits: 600, createdAt: before },
      ] });
      const row = { userId, creditAmount: 0, usageAmount: 0 };
      await tx.creditTransaction.createMany({ data: [
        { ...row, aiJobId: oldJob, kind: "usage", usageAmount: 3.125, createdAt: before },
        { ...row, aiJobId: oldJob, kind: "usage_settlement", usageAmount: actual - 3.125, createdAt: later },
        { ...row, aiJobId: currentJob, kind: "usage", usageAmount: 2.5, createdAt: since },
        { ...row, aiJobId: currentJob, kind: "usage_settlement", usageAmount: -0.25, createdAt: later },
        { ...row, aiJobId: failedJob, kind: "usage", usageAmount: 500, creditAmount: -100, createdAt: before },
        { ...row, aiJobId: failedJob, kind: "refund", usageAmount: -500, creditAmount: 100, createdAt: later },
        { ...row, kind: "usage", usageAmount: 6, createdAt: before },
        { ...row, kind: "usage", usageAmount: 0.75, createdAt: since },
        { ...row, aiJobId: oldJob, kind: "purchase", creditAmount: 7, createdAt: later },
        { ...row, aiJobId: oldJob, kind: "purchase_reversal", creditAmount: -2, createdAt: later },
        { ...row, aiJobId: oldJob, kind: "admin_usage_adjustment", usageAmount: 1.25, createdAt: later },
        { ...row, aiJobId: currentJob, kind: "purchase", creditAmount: 11, createdAt: before },
        { ...row, aiJobId: currentJob, kind: "admin_usage_adjustment", usageAmount: 3, createdAt: before },
      ] });

      expect(await getAiUsageTotals({ since, prisma: tx })).toEqual({
        consumedUnits: 3, purchasedCredits: 5, adminUsageAdjustment: 1.25,
      });
      expect(await getAiUsageTotals({ since: before, prisma: tx })).toEqual({
        consumedUnits: actual + 9, purchasedCredits: 16, adminUsageAdjustment: 4.25,
      });
      expect((await getAiUsageTotals({ since: new Date(since.getTime() + 1), prisma: tx })).consumedUnits).toBe(0);
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);

    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
  }, 45_000);

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
        countActiveSubscriptions({ now, planId: "pro" }),
      ]);

    expect(Array.isArray(statusCounts)).toBe(true);
    expect(Array.isArray(kindUsage)).toBe(true);
    expect(Array.isArray(topUsers)).toBe(true);
    expect(topUsers.length).toBeLessThanOrEqual(10);
    expect(Number.isFinite(totals.consumedUnits)).toBe(true);
    expect(Number.isFinite(totals.purchasedCredits)).toBe(true);
    expect(Number.isFinite(totals.adminUsageAdjustment)).toBe(true);
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
      expect(Number.isFinite(row.monthlyUsageUsed)).toBe(true);
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
