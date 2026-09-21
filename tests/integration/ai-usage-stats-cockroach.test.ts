import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  countActiveSubscriptions,
  consumeUsage,
  createAiJob,
  findCheckoutBillingOffer,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getCreditAccount,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  listRecentAiJobsByUserId,
  setDbProvider,
  settleUsage,
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

  it("aggregates valid decimal rows beyond the individual ledger limit", async () => {
    const userIds = [crypto.randomUUID(), crypto.randomUUID()];
    const jobIds = [crypto.randomUUID(), crypto.randomUUID()];
    const amount = "1500000000.062500";
    const total = 3_000_000_000.125;
    const rollback = new Error("Roll back large aggregate fixtures");

    await expect(prisma.$transaction(async (tx) => {
      const [newestJob, newestTransaction] = await Promise.all([
        tx.aiJob.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        tx.creditTransaction.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      ]);
      const since = new Date(Math.max(
        Date.now(), newestJob?.createdAt.getTime() ?? 0, newestTransaction?.createdAt.getTime() ?? 0,
      ) + 60_000);
      const baseline = await getAiBalanceTotals({ now: since, prisma: tx });
      await tx.user.createMany({ data: userIds.map((id) => ({ id, email: `${id}@aggregate-test.invalid` })) });
      await tx.creditAccount.createMany({ data: userIds.map((userId) => ({
        userId, monthlyUsageUsed: amount, purchasedCredits: amount, purchasedCreditDebt: amount,
        usagePeriodEnd: new Date(since.getTime() + 86_400_000),
      })) });
      await tx.aiJob.createMany({ data: jobIds.map((id) => ({
        id, userId: userIds[0], provider: "test", kind: "image", status: "succeeded",
        usageUnits: amount, reservedUsageUnits: amount, createdAt: since,
      })) });
      await tx.creditTransaction.createMany({ data: [
        ...jobIds.map((aiJobId) => ({ userId: userIds[0], aiJobId, kind: "usage", usageAmount: amount, creditAmount: 0, createdAt: since })),
        ...userIds.flatMap((userId) => [
          { userId, kind: "purchase", creditAmount: amount, usageAmount: 0, createdAt: since },
          { userId, kind: "admin_usage_adjustment", creditAmount: 0, usageAmount: `-${amount}`, createdAt: since },
          { userId, kind: "admin_credit_adjustment", creditAmount: 1_500_000_000, usageAmount: 0, createdAt: since },
          { userId, kind: "admin_credit_adjustment", creditAmount: -1_500_000_000, usageAmount: 0, createdAt: since },
        ]),
      ] });

      expect(await getAiJobUsageByKind({ since, prisma: tx })).toEqual([{ kind: "image", jobCount: 2, reservedUnits: total }]);
      expect(await getTopAiUsers({ since, limit: 1, prisma: tx })).toEqual([{ userId: userIds[0], jobCount: 2, reservedUnits: total }]);
      expect(await getAiUsageTotals({ since, prisma: tx })).toEqual({ consumedUnits: total, purchasedCredits: total, adminUsageAdjustment: -total });
      expect(await getAdminCreditAdjustmentTotals({ since, prisma: tx })).toEqual({ granted: 3_000_000_000, revoked: 3_000_000_000 });
      const addTotal = (value: number) => new Prisma.Decimal(value).plus(total).toNumber();
      expect(await getAiBalanceTotals({ now: since, prisma: tx })).toEqual({
        accountCount: baseline.accountCount + 2,
        monthlyUsageUsed: addTotal(baseline.monthlyUsageUsed),
        purchasedCredits: addTotal(baseline.purchasedCredits),
        purchasedCreditDebt: addTotal(baseline.purchasedCreditDebt),
      });
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);

    expect(await prisma.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }, 45_000);

  it("reports the complete settlement delta after allowance rollover", async () => {
    const userId = crypto.randomUUID();
    const rollback = new Error("Roll back period rollover fixtures");
    await expect(prisma.$transaction(async (tx) => {
      const newest = await tx.aiJob.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const since = new Date(Math.max(Date.now(), newest?.createdAt.getTime() ?? 0) + 60_000);
      const oldPeriod = { start: since, end: new Date(since.getTime() + 86_400_000) };
      const nextPeriod = { start: oldPeriod.end, end: new Date(oldPeriod.end.getTime() + 86_400_000) };
      await tx.user.create({ data: { id: userId, email: `${userId}@rollover-test.invalid` } });
      await tx.creditAccount.create({ data: { userId, purchasedCredits: 10 } });
      const oldJob = await createAiJob({ userId, kind: "image", provider: "test", status: "succeeded", usageUnits: 25, reservedUsageUnits: 25, usageUnitUsdMicros: 10_000, prisma: tx });
      await tx.aiJob.update({ where: { id: oldJob.id }, data: { createdAt: since } });
      await consumeUsage({ userId, aiJobId: oldJob.id, amount: 25, monthlyUsageLimit: 20, usagePeriod: oldPeriod, prisma: tx });
      const newJob = await createAiJob({ userId, kind: "image", provider: "test", status: "running", usageUnits: 5, prisma: tx });
      await tx.aiJob.update({ where: { id: newJob.id }, data: { createdAt: nextPeriod.start } });
      await consumeUsage({ userId, aiJobId: newJob.id, amount: 5, monthlyUsageLimit: 20, usagePeriod: nextPeriod, prisma: tx });
      const settlement = { userId, aiJobId: oldJob.id, actualAmount: 12.5, providerCostUsdMicros: 125_000, monthlyUsageLimit: 20, currentUsagePeriod: nextPeriod, prisma: tx };
      await settleUsage(settlement);
      await settleUsage(settlement);

      expect(await getCreditAccount({ userId, prisma: tx })).toMatchObject({ monthlyUsageUsed: 5, purchasedCredits: 10, purchasedCreditDebt: 0 });
      const rows = await tx.creditTransaction.findMany({ where: { userId, kind: "usage_settlement" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].usageAmount.toNumber()).toBe(-7.5);
      expect(rows[0].creditAmount.toNumber()).toBe(5);
      expect(rows[0].usagePeriodStart).toEqual(oldPeriod.start);
      expect((await getAiUsageTotals({ since, prisma: tx })).consumedUnits).toBe(17.5);
      expect((await getAiUsageTotals({ since: nextPeriod.start, prisma: tx })).consumedUnits).toBe(5);
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
