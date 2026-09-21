import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPurchasedCredits,
  adjustPurchasedCreditsByAdmin,
  consumeUsage,
  countActiveSubscriptions,
  createAiJob,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  listRecentAiJobsByUserId,
  reconcilePurchasedCreditReversal,
  refundUsage,
  setDbProvider,
  settleUsage,
  setMonthlyUsageUsedByAdmin,
  upsertSubscription,
} from "@beutl/db";
import {
  aiUsageRangeStart,
  DEFAULT_AI_USAGE_RANGE,
  parseAiUsageRange,
} from "../../apps/admin/src/lib/ai-usage-range";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const PERIOD = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
  end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
};
const MONTHLY_LIMIT = 500;
// Everything the stub writes is stamped with the wall clock, so a window that
// starts in the past covers the whole fixture.
const SINCE = new Date(Date.now() - 60 * 60 * 1000);

async function reserve({
  userId,
  jobId,
  kind,
  status,
  units,
  reservedUnits,
}: {
  userId: string;
  jobId: string;
  kind: string;
  status: string;
  units: number;
  reservedUnits?: number;
}) {
  const job = await createAiJob({
    userId,
    kind,
    provider: "openrouter",
    status,
    usageUnits: units,
    reservedUsageUnits: reservedUnits,
  });
  await consumeUsage({
    userId,
    amount: units,
    monthlyUsageLimit: MONTHLY_LIMIT,
    usagePeriod: PERIOD,
    aiJobId: job.id,
  });
  return job;
}

async function settledReservation(userId: string, kind: string, reserved: number, actual: number) {
  const job = await reserve({
    userId,
    jobId: "settlement-fixture",
    kind,
    status: "succeeded",
    units: reserved,
    reservedUnits: reserved,
  });
  await settleUsage({
    userId,
    aiJobId: job.id,
    actualAmount: actual,
    providerCostUsdMicros: Math.round(actual * 10_000),
    monthlyUsageLimit: MONTHLY_LIMIT,
    currentUsagePeriod: PERIOD,
  });
  return job;
}

describe("AI usage aggregates", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    Object.assign(memory.prisma.subscriptionEntitlementHold, {
      findMany: async () => [],
    });
    Object.assign(memory.prisma.accountDeletionIntent, {
      findMany: async () => [],
    });
    setDbProvider(async () => memory.prisma as never);
  });

  it("counts jobs by status", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 20,
    });
    await reserve({
      userId: "user-a",
      jobId: "job-2",
      kind: "image",
      status: "succeeded",
      units: 20,
    });
    await reserve({
      userId: "user-b",
      jobId: "job-3",
      kind: "video",
      status: "failed",
      units: 40,
    });

    expect(await getAiJobStatusCounts({ since: SINCE })).toEqual([
      { status: "succeeded", jobCount: 2 },
      { status: "failed", jobCount: 1 },
    ]);
  });

  it("sums reserved units per operation kind, largest first", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 20,
    });
    await reserve({
      userId: "user-b",
      jobId: "job-2",
      kind: "video",
      status: "succeeded",
      units: 120,
    });
    await reserve({
      userId: "user-b",
      jobId: "job-3",
      kind: "video",
      status: "succeeded",
      units: 80,
    });

    expect(await getAiJobUsageByKind({ since: SINCE })).toEqual([
      { kind: "video", jobCount: 2, reservedUnits: 200 },
      { kind: "image", jobCount: 1, reservedUnits: 20 },
    ]);
  });

  it("keeps original reservations across settlements, refunds, and legacy jobs", async () => {
    await settledReservation("user-a", "image", 3.125, 0.625);
    await settledReservation("user-b", "video", 1.75, 4.25);
    await settledReservation("user-a", "image", 0.125, 0);
    await reserve({ userId: "user-a", jobId: "legacy", kind: "image", status: "succeeded", units: 0.5 });
    await reserve({ userId: "user-c", jobId: "queued", kind: "image", status: "queued", units: 0.25, reservedUnits: 0.25 });
    const failed = await reserve({ userId: "user-c", jobId: "failed", kind: "image", status: "failed", units: 1.125, reservedUnits: 1.125 });
    await refundUsage({ userId: "user-c", aiJobId: failed.id, usagePeriod: PERIOD });

    expect(await getAiJobUsageByKind({ since: SINCE })).toEqual([
      { kind: "image", jobCount: 5, reservedUnits: 5.125 },
      { kind: "video", jobCount: 1, reservedUnits: 1.75 },
    ]);
    expect((await getAiUsageTotals({ since: SINCE })).consumedUnits).toBe(5.625);
    expect(await getAiJobUsageByKind({ since: new Date(Date.now() + 60_000) })).toEqual([]);
  });

  it("ranks and limits users by combined legacy and new reservations", async () => {
    await settledReservation("user-a", "image", 3.125, 0.125);
    await reserve({ userId: "user-a", jobId: "legacy-a", kind: "image", status: "succeeded", units: 2.25 });
    await settledReservation("user-b", "video", 5.25, 20);
    await reserve({ userId: "user-c", jobId: "legacy-c", kind: "image", status: "succeeded", units: 5.125 });
    const old = await settledReservation("user-old", "video", 100, 100);
    memory.state.aiJobs.get(old.id)!.createdAt = new Date(SINCE.getTime() - 1);

    expect(await getTopAiUsers({ since: SINCE, limit: 3 })).toEqual([
      { userId: "user-a", jobCount: 2, reservedUnits: 5.375 },
      { userId: "user-b", jobCount: 1, reservedUnits: 5.25 },
      { userId: "user-c", jobCount: 1, reservedUnits: 5.125 },
    ]);
    expect(await getTopAiUsers({ since: SINCE, limit: 1 })).toEqual([
      { userId: "user-a", jobCount: 2, reservedUnits: 5.375 },
    ]);
  });

  it("exposes reservations separately from actual usage in recent job rows", async () => {
    const settled = await settledReservation("user-a", "image", 3.125, 0.125);
    const legacy = await reserve({ userId: "user-a", jobId: "legacy-a", kind: "image", status: "succeeded", units: 2.25 });
    const rows = await listRecentAiJobsByUserId({ userId: "user-a", limit: 10 });

    expect(rows.find((row) => row.id === settled.id)).toMatchObject({ usageUnits: 0.125, reservedUnits: 3.125 });
    expect(rows.find((row) => row.id === legacy.id)).toMatchObject({ usageUnits: 2.25, reservedUnits: 2.25 });
  });

  it("reports consumption net of refunds across both balance sources", async () => {
    await addPurchasedCredits({
      userId: "user-a",
      amount: 300,
      stripePaymentId: "pi_usage_1",
    });
    // 500 of allowance plus 100 of purchased credits.
    const job = await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "video",
      status: "failed",
      units: 600,
    });
    let totals = await getAiUsageTotals({ since: SINCE });
    expect(totals.consumedUnits).toBe(600);
    expect(totals.purchasedCredits).toBe(300);

    await refundUsage({
      userId: "user-a",
      usagePeriod: PERIOD,
      aiJobId: job.id,
    });

    totals = await getAiUsageTotals({ since: SINCE });
    expect(totals.consumedUnits).toBe(0);
    expect(totals.purchasedCredits).toBe(300);
  });

  it("nets a reversed purchase out of the credits purchased", async () => {
    await addPurchasedCredits({
      userId: "user-a",
      amount: 500,
      stripePaymentId: "pi_usage_2",
      stripePayment: { amount: 1000, currency: "jpy" },
    });
    expect((await getAiUsageTotals({ since: SINCE })).purchasedCredits).toBe(500);

    await reconcilePurchasedCreditReversal({
      stripePaymentId: "pi_usage_2",
      stripePayment: { amount: 1000, currency: "jpy" },
      reversalKind: "refund",
      reversalId: "re_usage_2",
      reversalAmount: 1000,
      reversalCurrency: "jpy",
      status: "succeeded",
      active: true,
      stripeEventId: "evt_usage_2",
      stripeEventCreatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect((await getAiUsageTotals({ since: SINCE })).purchasedCredits).toBe(0);
  });

  it("separates administrator adjustments from consumption", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 200,
    });
    await adjustPurchasedCreditsByAdmin({
      userId: "user-a",
      creditDelta: 500,
      adjustmentKey: "stats-grant-a",
    });
    await adjustPurchasedCreditsByAdmin({
      userId: "user-a",
      creditDelta: -120,
      adjustmentKey: "stats-revoke-a",
    });
    await setMonthlyUsageUsedByAdmin({
      userId: "user-a",
      monthlyUsageUsed: 50,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
    });

    const totals = await getAiUsageTotals({ since: SINCE });
    expect(totals.consumedUnits).toBe(200);
    expect(totals.purchasedCredits).toBe(0);
    expect(totals.adminUsageAdjustment).toBe(-150);

    // Grants and revokes cancel out in a plain sum, so they are counted apart.
    expect(await getAdminCreditAdjustmentTotals({ since: SINCE })).toEqual({
      granted: 500,
      revoked: 120,
    });
  });

  it("excludes rows created before the window", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 20,
    });

    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(await getAiJobStatusCounts({ since: future })).toEqual([]);
    expect(await getAiUsageTotals({ since: future })).toEqual({
      consumedUnits: 0,
      purchasedCredits: 0,
      adminUsageAdjustment: 0,
    });
  });

  it("ranks the heaviest consumers", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 20,
    });
    await reserve({
      userId: "user-b",
      jobId: "job-2",
      kind: "video",
      status: "succeeded",
      units: 300,
    });
    await reserve({
      userId: "user-b",
      jobId: "job-3",
      kind: "image",
      status: "succeeded",
      units: 40,
    });

    expect(await getTopAiUsers({ since: SINCE, limit: 10 })).toEqual([
      { userId: "user-b", jobCount: 2, reservedUnits: 340 },
      { userId: "user-a", jobCount: 1, reservedUnits: 20 },
    ]);
    expect(await getTopAiUsers({ since: SINCE, limit: 1 })).toEqual([
      { userId: "user-b", jobCount: 2, reservedUnits: 340 },
    ]);
    await expect(getTopAiUsers({ since: SINCE, limit: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it("totals the balances every account currently holds", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 120,
    });
    await adjustPurchasedCreditsByAdmin({
      userId: "user-b",
      creditDelta: 400,
      adjustmentKey: "stats-grant-b",
    });

    expect(await getAiBalanceTotals({ now: new Date() })).toEqual({
      accountCount: 2,
      monthlyUsageUsed: 120,
      purchasedCredits: 400,
      purchasedCreditDebt: 0,
    });
  });

  it("leaves a lapsed account's counter out of the monthly total", async () => {
    await reserve({
      userId: "user-a",
      jobId: "job-1",
      kind: "image",
      status: "succeeded",
      units: 120,
    });
    const lapsedJob = await createAiJob({
      userId: "user-lapsed",
      kind: "image",
      provider: "openrouter",
      status: "succeeded",
      usageUnits: 400,
    });
    await consumeUsage({
      userId: "user-lapsed",
      amount: 400,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: {
        start: new Date("2026-06-01T00:00:00.000Z"),
        end: new Date("2026-07-01T00:00:00.000Z"),
      },
      aiJobId: lapsedJob.id,
    });

    // The counter is cleared only when that account next spends, so the row
    // still holds June's total. Counting it reports consumption of an allowance
    // nobody is drawing on now.
    expect(await getAiBalanceTotals({ now: new Date() })).toMatchObject({
      accountCount: 2,
      monthlyUsageUsed: 120,
    });
  });

  it("returns one row more than asked so truncation is detectable", async () => {
    for (const userId of ["user-a", "user-b", "user-c"]) {
      await adjustPurchasedCreditsByAdmin({
        userId,
        creditDelta: 100,
        adjustmentKey: `stats-grant-${userId}`,
      });
    }

    // The caller asks for two and gets three, which is how it knows more exist.
    expect(
      await listCreditAccountUsageSnapshot({ limit: 2 }),
    ).toHaveLength(3);
    expect(
      await listCreditAccountUsageSnapshot({ limit: 10 }),
    ).toHaveLength(3);
    await expect(
      listCreditAccountUsageSnapshot({ limit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("counts only subscriptions that are still within their period", async () => {
    const now = new Date();
    await upsertSubscription({
      userId: "user-a",
      stripeSubscriptionId: "sub_active",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date(now.getTime() - 1000),
      currentPeriodEnd: new Date(now.getTime() + 86_400_000),
      billingOfferId: "offer-1",
    });
    await upsertSubscription({
      userId: "user-b",
      stripeSubscriptionId: "sub_expired",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date(now.getTime() - 86_400_000),
      currentPeriodEnd: new Date(now.getTime() - 1000),
      billingOfferId: "offer-1",
    });
    await upsertSubscription({
      userId: "user-c",
      stripeSubscriptionId: "sub_canceled",
      status: "canceled",
      planId: "pro",
      currentPeriodStart: new Date(now.getTime() - 1000),
      currentPeriodEnd: new Date(now.getTime() + 86_400_000),
      billingOfferId: "offer-1",
    });

    expect((await countActiveSubscriptions({ now, planId: "pro" })).total).toBe(1);
  });

  it("excludes only active entitlement holds for the current subscription period", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const periodStart = new Date("2026-08-01T00:00:00.000Z");
    const periodEnd = new Date("2026-09-01T00:00:00.000Z");
    for (const userId of ["user-held", "user-historical"]) {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub-${userId}`,
        status: "active",
        planId: "pro",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        billingOfferId: "offer-1",
      });
    }

    const findMany = vi.fn().mockResolvedValue([
      {
        userId: "user-held",
        stripeSubscriptionId: "sub-user-held",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        user: {
          subscriptions: [
            {
              stripeSubscriptionId: "sub-user-held",
              tier: null,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          ],
        },
      },
      {
        userId: "user-historical",
        stripeSubscriptionId: "sub-user-historical",
        billingPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
        user: {
          subscriptions: [
            {
              stripeSubscriptionId: "sub-user-historical",
              tier: null,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          ],
        },
      },
    ]);
    Object.assign(memory.prisma.subscriptionEntitlementHold, { findMany });

    expect((await countActiveSubscriptions({ now, planId: "pro" })).total).toBe(1);
    // Only holds of users with a live row of this plan are loaded; the counts
    // themselves stay in the database.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          user: {
            subscriptions: {
              some: expect.objectContaining({ planId: "pro" }),
            },
          },
        }),
      }),
    );
  });

  it("excludes subscriptions while an authorized deletion intent is active", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    for (const userId of ["user-active", "user-deleting"]) {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub-${userId}`,
        status: "active",
        planId: "pro",
        currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
        billingOfferId: "offer-1",
      });
    }
    const findMany = vi.fn().mockResolvedValue([
      { userId: "user-deleting", user: { subscriptions: [{ tier: null }] } },
    ]);
    Object.assign(memory.prisma.accountDeletionIntent, { findMany });

    expect((await countActiveSubscriptions({ now, planId: "pro" })).total).toBe(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          expiresAt: { gt: now },
          user: {
            subscriptions: {
              some: expect.objectContaining({ planId: "pro" }),
            },
          },
        },
      }),
    );
  });
});

describe("AI usage report window", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");

  it("falls back to the default for anything unrecognized", () => {
    expect(parseAiUsageRange("30d")).toBe("30d");
    expect(parseAiUsageRange("1y")).toBe(DEFAULT_AI_USAGE_RANGE);
    expect(parseAiUsageRange(undefined)).toBe(DEFAULT_AI_USAGE_RANGE);
    expect(parseAiUsageRange(["7d"])).toBe(DEFAULT_AI_USAGE_RANGE);
  });

  it("resolves each window to its start", () => {
    expect(aiUsageRangeStart("24h", now)).toEqual(
      new Date("2026-08-16T12:00:00.000Z"),
    );
    expect(aiUsageRangeStart("7d", now)).toEqual(
      new Date("2026-08-10T12:00:00.000Z"),
    );
    expect(aiUsageRangeStart("90d", now)).toEqual(
      new Date("2026-05-19T12:00:00.000Z"),
    );
  });
});
