import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeUsage,
  addPurchasedCredits,
  createAiJob,
  getCreditAccount,
  getAiUsageTotals,
  markAiJobSucceeded,
  setDbProvider,
  settleUsage,
  setMonthlyUsageUsedByAdmin,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PERIOD = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};

describe("settling an AI reservation to actual provider cost", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });
  afterEach(() => vi.useRealTimers());

  async function reserve(units: number, monthlyLimit = units) {
    const job = await createAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "vercel-gateway",
      status: "running",
      usageUnits: units,
      reservedUsageUnits: units,
      usageUnitUsdMicros: 10_000,
      usagePercent: 150,
      model: "openai/gpt-image-2",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: units,
      monthlyUsageLimit: monthlyLimit,
      usagePeriod: PERIOD,
      aiJobId: job.id,
    });
    await markAiJobSucceeded({ jobId: job.id });
    return job;
  }

  it("returns the unused reservation and records the actual charge", async () => {
    const job = await reserve(20);

    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 6,
      providerCostUsdMicros: 40_000,
      monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 6,
      providerCostUsdMicros: 40_000,
      monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 6,
      purchasedCreditDebt: 0,
    });
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      reservedUsageUnits: 20,
      usageUnits: 6,
      usagePercent: 150,
      providerCostUsdMicros: 40_000,
    });
    expect(memory.state.creditTransactions.at(-1)).toMatchObject({
      kind: "usage_settlement",
      usageAmount: -14,
    });
    expect(
      memory.state.creditTransactions.filter(
        (transaction) => transaction.kind === "usage_settlement",
      ),
    ).toHaveLength(1);
  });

  it.each([
    { reserved: 20, actual: 6.125, purchased: 0, monthlyDelta: -13.875, creditDelta: 0 },
    { reserved: 20, actual: 0, purchased: 0, monthlyDelta: -20, creditDelta: 0 },
    { reserved: 25, actual: 12.5, purchased: 10, monthlyDelta: -7.5, creditDelta: 5 },
  ])("records the full historical settlement after renewal: $reserved to $actual", async (test) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:00.000Z"));
    if (test.purchased) await addPurchasedCredits({ userId: USER_ID, amount: test.purchased, stripePaymentId: "pi_rollover" });
    const job = await reserve(test.reserved, 20);
    const nextPeriod = { start: PERIOD.end, end: new Date("2026-11-01T00:00:00.000Z") };
    vi.setSystemTime(new Date("2026-10-01T00:01:00.000Z"));
    const current = await createAiJob({ userId: USER_ID, kind: "image", provider: "test", status: "running", usageUnits: 5 });
    await consumeUsage({ userId: USER_ID, aiJobId: current.id, amount: 5, monthlyUsageLimit: 20, usagePeriod: nextPeriod });
    const settlement = { userId: USER_ID, aiJobId: job.id, actualAmount: test.actual, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: nextPeriod };
    await settleUsage(settlement);
    await settleUsage(settlement);

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({ monthlyUsageUsed: 5, purchasedCredits: test.purchased, purchasedCreditDebt: 0 });
    expect(memory.state.aiJobs.get(job.id)?.usageUnits).toBe(test.actual);
    const rows = memory.state.creditTransactions.filter((row) => row.kind === "usage_settlement");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usageAmount: test.monthlyDelta, creditAmount: test.creditDelta, usagePeriodStart: PERIOD.start, usagePeriodEnd: PERIOD.end });
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(test.actual + 5);
    expect((await getAiUsageTotals({ since: nextPeriod.start })).consumedUnits).toBe(5);
  });

  it("retains the charge correction when a same-period admin reset limits restoration", async () => {
    const job = await reserve(20);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 5, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 6, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(0);
    expect(memory.state.creditTransactions.find((row) => row.kind === "usage_settlement")).toMatchObject({ usageAmount: -14 });
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(6);
  });

  it("records an unexpected overrun as purchased-credit debt", async () => {
    const job = await reserve(5);

    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 8,
      providerCostUsdMicros: 80_000,
      monthlyUsageLimit: 5,
      currentUsagePeriod: PERIOD,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 5,
      purchasedCredits: 0,
      purchasedCreditDebt: 3,
    });
    expect(memory.state.creditTransactions.at(-1)).toMatchObject({
      kind: "usage_settlement",
      creditAmount: -3,
      debtAmount: 3,
    });
  });

  it("settles and refunds fractional usage without rounding to a whole unit", async () => {
    const job = await createAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "vercel-gateway",
      status: "running",
      usageUnits: 0.12,
      reservedUsageUnits: 0.12,
      usageUnitUsdMicros: 10_000,
      usagePercent: 150,
      model: "openai/gpt-image-2",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 0.12,
      monthlyUsageLimit: 1,
      usagePeriod: PERIOD,
      aiJobId: job.id,
    });
    await markAiJobSucceeded({ jobId: job.id });

    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 0.075,
      providerCostUsdMicros: 500,
      monthlyUsageLimit: 1,
      currentUsagePeriod: PERIOD,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 0.075,
      purchasedCreditDebt: 0,
    });
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      reservedUsageUnits: 0.12,
      usageUnits: 0.075,
    });
    expect(memory.state.creditTransactions.at(-1)).toMatchObject({
      kind: "usage_settlement",
      usageAmount: -0.045,
    });
  });

  it("records only the fractional overrun as debt", async () => {
    const job = await createAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "vercel-gateway",
      status: "running",
      usageUnits: 0.8,
      reservedUsageUnits: 0.8,
      usageUnitUsdMicros: 10_000,
      usagePercent: 100,
      model: "openai/gpt-image-2",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 0.8,
      monthlyUsageLimit: 1,
      usagePeriod: PERIOD,
      aiJobId: job.id,
    });
    await markAiJobSucceeded({ jobId: job.id });

    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 1.25,
      providerCostUsdMicros: 12_500,
      monthlyUsageLimit: 1,
      currentUsagePeriod: PERIOD,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 1,
      purchasedCredits: 0,
      purchasedCreditDebt: 0.25,
    });
    expect(memory.state.creditTransactions.at(-1)).toMatchObject({
      kind: "usage_settlement",
      usageAmount: 0.2,
      creditAmount: -0.25,
      debtAmount: 0.25,
    });
  });
});
