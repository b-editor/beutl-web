import { beforeEach, describe, expect, it } from "vitest";
import {
  addPurchasedCredits,
  adjustPurchasedCreditsByAdmin,
  consumeUsage,
  countActiveProSubscriptions,
  createAiJob,
  getAdminCreditAdjustmentTotals,
  getAiBalanceTotals,
  getAiJobStatusCounts,
  getAiJobUsageByKind,
  getAiUsageTotals,
  getTopAiUsers,
  listCreditAccountUsageSnapshot,
  reconcilePurchasedCreditReversal,
  refundUsage,
  setDbProvider,
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
}: {
  userId: string;
  jobId: string;
  kind: string;
  status: string;
  units: number;
}) {
  const job = await createAiJob({
    userId,
    kind,
    provider: "openrouter",
    status,
    usageUnits: units,
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

describe("AI usage aggregates", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
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

    expect(await countActiveProSubscriptions({ now, planId: "pro" })).toBe(1);
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
