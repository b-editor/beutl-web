import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeUsage,
  addPurchasedCredits,
  createAiJob,
  getCreditAccount,
  getAiUsageTotals,
  listEstimatedGatewayVideoJobsForReconciliation,
  markAiJobSucceeded,
  prepareAiJobDeletionByUserId,
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

  async function reserveVideo(units: number, monthlyLimit = units, providerJobId?: string) {
    const job = await createAiJob({
      userId: USER_ID, kind: "video", provider: "vercel-gateway",
      status: "running", usageUnits: units, reservedUsageUnits: units,
      usageUnitUsdMicros: 10_000, usagePercent: 100,
      providerJobId,
      model: "spacexai/grok-imagine-video",
    });
    await consumeUsage({
      userId: USER_ID, amount: units, monthlyUsageLimit: monthlyLimit,
      usagePeriod: PERIOD, aiJobId: job.id,
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

  it("corrects an estimated Gateway video after its actual charge arrives", async () => {
    const job = await createAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "vercel-gateway",
      status: "running",
      usageUnits: 50.4,
      reservedUsageUnits: 50.4,
      estimatedUsageUnits: 42,
      usageUnitUsdMicros: 10_000,
      usagePercent: 100,
      model: "spacexai/grok-imagine-video",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 50.4,
      monthlyUsageLimit: 100,
      usagePeriod: PERIOD,
      aiJobId: job.id,
    });
    await markAiJobSucceeded({ jobId: job.id });
    await settleUsage({
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 42,
      providerCostUsdMicros: null,
      estimatedProviderCost: true,
      monthlyUsageLimit: 100,
      currentUsagePeriod: PERIOD,
    });
    const correction = {
      userId: USER_ID,
      aiJobId: job.id,
      actualAmount: 40.042,
      providerCostUsdMicros: 400_420,
      monthlyUsageLimit: 100,
      currentUsagePeriod: PERIOD,
      allowActualCorrection: true,
    };
    await settleUsage(correction);
    await settleUsage(correction);

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 40.042,
      purchasedCredits: 0,
    });
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      usageUnits: 40.042,
      reservedUsageUnits: 50.4,
      providerCostUsdMicros: 400_420,
    });
    expect(memory.state.creditTransactions.filter((row) =>
      row.kind === "usage_actual_correction" && row.aiJobId === job.id
    )).toEqual([expect.objectContaining({ usageAmount: -1.958, creditAmount: 0 })]);
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(40.042);
  });

  it("records a zero-delta correction so an audit-null actual cost is not retried", async () => {
    const job = await reserveVideo(20);
    const base = {
      userId: USER_ID, aiJobId: job.id, actualAmount: 20,
      providerCostUsdMicros: null, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    };
    await settleUsage({ ...base, estimatedProviderCost: true });
    await settleUsage({ ...base, allowActualCorrection: true });
    await settleUsage({ ...base, allowActualCorrection: true });

    expect(memory.state.creditTransactions.filter((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toHaveLength(1);
    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 20,
    });
  });

  it("records a matching actual cost without a zero-valued ledger row", async () => {
    const job = await reserveVideo(20);
    const base = {
      userId: USER_ID, aiJobId: job.id, actualAmount: 20,
      monthlyUsageLimit: 20, currentUsagePeriod: PERIOD,
    };
    await settleUsage({ ...base, providerCostUsdMicros: null, estimatedProviderCost: true });
    await settleUsage({ ...base, providerCostUsdMicros: 200_000, allowActualCorrection: true });
    await settleUsage({ ...base, providerCostUsdMicros: 200_000, allowActualCorrection: true });

    expect(memory.state.aiJobs.get(job.id)?.providerCostUsdMicros).toBe(200_000);
    expect(memory.state.creditTransactions.some((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toBe(false);
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(20);
  });

  it("does not reprice an already actual-billed video whose audit value is null", async () => {
    const job = await reserveVideo(20);
    const base = {
      userId: USER_ID, aiJobId: job.id, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD, providerCostUsdMicros: null,
    };
    await settleUsage({ ...base, actualAmount: 18 });
    await settleUsage({ ...base, actualAmount: 12, allowActualCorrection: true });

    expect(memory.state.aiJobs.get(job.id)?.usageUnits).toBe(18);
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(18);
    expect(memory.state.creditTransactions.some((row) =>
      row.aiJobId === job.id && row.kind === "usage_estimate_pending"
    )).toBe(false);
  });

  it("retains a deleted video's billing identity until its estimate is corrected", async () => {
    const job = await reserveVideo(20, 20, "provider-deleted-estimate");
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 18,
      providerCostUsdMicros: null, estimatedProviderCost: true,
      monthlyUsageLimit: 20, currentUsagePeriod: PERIOD,
    });

    await prepareAiJobDeletionByUserId({ userId: USER_ID, jobId: job.id });
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      deletedAt: expect.any(Date), providerJobId: "provider-deleted-estimate",
      inputParams: null,
    });
    expect(await listEstimatedGatewayVideoJobsForReconciliation({
      updatedBefore: new Date(Date.now() + 60_000),
    })).toEqual([expect.objectContaining({ id: job.id })]);

    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 16,
      providerCostUsdMicros: 160_000, allowActualCorrection: true,
      monthlyUsageLimit: 20, currentUsagePeriod: PERIOD,
    });
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      providerJobId: null, usageUnits: 16, deletedAt: expect.any(Date),
    });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(16);
  });

  it("restores the remaining purchased share before monthly allowance", async () => {
    await addPurchasedCredits({ userId: USER_ID, amount: 10, stripePaymentId: "pi_late_cost" });
    const job = await reserveVideo(25, 20);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 22,
      providerCostUsdMicros: null, estimatedProviderCost: true, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 18,
      providerCostUsdMicros: 180_000, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD, allowActualCorrection: true,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 18, purchasedCredits: 10, purchasedCreditDebt: 0,
    });
    expect(memory.state.creditTransactions.find((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toMatchObject({ usageAmount: -2, creditAmount: 2, debtAmount: 0 });
  });

  it("keeps a late correction in its original period without crediting a renewed one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:00.000Z"));
    const job = await reserveVideo(20);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 18,
      providerCostUsdMicros: null, estimatedProviderCost: true, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });
    const nextPeriod = { start: PERIOD.end, end: new Date("2026-11-01T00:00:00.000Z") };
    vi.setSystemTime(new Date("2026-10-01T00:01:00.000Z"));
    const current = await createAiJob({
      userId: USER_ID, kind: "image", provider: "test", status: "running", usageUnits: 5,
    });
    await consumeUsage({
      userId: USER_ID, aiJobId: current.id, amount: 5,
      monthlyUsageLimit: 20, usagePeriod: nextPeriod,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 16,
      providerCostUsdMicros: 160_000, monthlyUsageLimit: 20,
      currentUsagePeriod: nextPeriod, allowActualCorrection: true,
    });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(5);
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(21);
    expect((await getAiUsageTotals({ since: nextPeriod.start })).consumedUnits).toBe(5);
    expect(memory.state.creditTransactions.find((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toMatchObject({
      usageAmount: -2, usagePeriodStart: PERIOD.start, usagePeriodEnd: PERIOD.end,
    });
  });

  it("does not lower an administrator's post-reservation usage baseline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
    const job = await reserveVideo(20);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 18,
      providerCostUsdMicros: null, estimatedProviderCost: true, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });
    vi.advanceTimersByTime(1_000);
    await setMonthlyUsageUsedByAdmin({
      userId: USER_ID, monthlyUsageUsed: 0, monthlyUsageLimit: 20,
      usagePeriod: PERIOD,
    });
    vi.advanceTimersByTime(1_000);
    const newer = await createAiJob({
      userId: USER_ID, kind: "image", provider: "test", status: "running", usageUnits: 10,
    });
    await consumeUsage({
      userId: USER_ID, aiJobId: newer.id, amount: 10,
      monthlyUsageLimit: 20, usagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 16,
      providerCostUsdMicros: 160_000, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD, allowActualCorrection: true,
    });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(10);
    expect(memory.state.creditTransactions.find((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toMatchObject({ usageAmount: -2, creditAmount: 0 });
  });

  it("pays down estimate overrun debt when the actual charge is lower", async () => {
    const job = await reserveVideo(5);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 8,
      providerCostUsdMicros: null, estimatedProviderCost: true, monthlyUsageLimit: 5,
      currentUsagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 6,
      providerCostUsdMicros: 60_000, monthlyUsageLimit: 5,
      currentUsagePeriod: PERIOD, allowActualCorrection: true,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 5, purchasedCredits: 0, purchasedCreditDebt: 1,
    });
    expect(memory.state.creditTransactions.find((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toMatchObject({ usageAmount: 0, creditAmount: 2, debtAmount: -2 });
  });

  it("charges only the additional actual cost when it exceeds the estimate", async () => {
    const job = await reserveVideo(5);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 4,
      providerCostUsdMicros: null, estimatedProviderCost: true, monthlyUsageLimit: 5,
      currentUsagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 7,
      providerCostUsdMicros: 70_000, monthlyUsageLimit: 5,
      currentUsagePeriod: PERIOD, allowActualCorrection: true,
    });

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 5, purchasedCredits: 0, purchasedCreditDebt: 2,
    });
    expect(memory.state.creditTransactions.find((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toMatchObject({ usageAmount: 1, creditAmount: -2, debtAmount: 2 });
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(7);
  });

  it("never revises an already actual-billed non-video job", async () => {
    const job = await reserve(20);
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 6,
      providerCostUsdMicros: 40_000, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD,
    });
    await settleUsage({
      userId: USER_ID, aiJobId: job.id, actualAmount: 5,
      providerCostUsdMicros: 50_000, monthlyUsageLimit: 20,
      currentUsagePeriod: PERIOD, allowActualCorrection: true,
    });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(6);
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({
      usageUnits: 6, providerCostUsdMicros: 40_000,
    });
    expect(memory.state.creditTransactions.some((row) =>
      row.aiJobId === job.id && row.kind === "usage_actual_correction"
    )).toBe(false);
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

  it("retains the charge correction without changing an administrator's new baseline", async () => {
    const job = await reserve(20);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 5, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 6, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(5);
    expect(memory.state.creditTransactions.find((row) => row.kind === "usage_settlement")).toMatchObject({ usageAmount: -14 });
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(6);
  });

  it.each([
    { reserved: 20, actual: 18, purchased: 0, monthlyDelta: -2, creditDelta: 0 },
    { reserved: 25, actual: 12.5, purchased: 10, monthlyDelta: -7.5, creditDelta: 5 },
  ])("preserves post-reset usage when settling a pre-reset reservation: $reserved to $actual", async (test) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
    if (test.purchased) {
      await addPurchasedCredits({ userId: USER_ID, amount: test.purchased, stripePaymentId: "pi_admin_reset" });
    }
    const oldJob = await reserve(test.reserved, 20);
    vi.advanceTimersByTime(1_000);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 0, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    vi.advanceTimersByTime(1_000);
    const newJob = await reserve(10, 20);
    const settlement = { userId: USER_ID, aiJobId: oldJob.id, actualAmount: test.actual, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD };
    await settleUsage(settlement);
    await settleUsage(settlement);

    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({ monthlyUsageUsed: 10, purchasedCredits: test.purchased, purchasedCreditDebt: 0 });
    const rows = memory.state.creditTransactions.filter((row) => row.kind === "usage_settlement");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usageAmount: test.monthlyDelta, creditAmount: test.creditDelta });
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(test.actual + 10);

    // The reset must not prevent restoring a reservation made after it.
    await settleUsage({ ...settlement, aiJobId: newJob.id, actualAmount: 8 });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(8);
    expect((await getAiUsageTotals({ since: PERIOD.start })).consumedUnits).toBe(test.actual + 8);
  });

  it("protects post-reset usage when the reset shares the reservation timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
    const job = await reserve(20);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 0, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await reserve(10, 20);
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 18, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(10);
    expect(memory.state.creditTransactions.find((row) => row.kind === "usage_settlement")).toMatchObject({ usageAmount: -2 });
  });

  it("still restores allowance after a no-op admin adjustment", async () => {
    const job = await reserve(20);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 20, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 18, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(18);
    expect(memory.state.creditTransactions.some((row) => row.kind === "admin_usage_adjustment")).toBe(false);
  });

  it("still restores allowance when an administrator only increases usage", async () => {
    const job = await reserve(10, 20);
    await setMonthlyUsageUsedByAdmin({ userId: USER_ID, monthlyUsageUsed: 15, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 8, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(13);
  });

  it("ignores another user's usage adjustment", async () => {
    const job = await reserve(20);
    const otherUserId = "22222222-2222-4222-8222-222222222222";
    await setMonthlyUsageUsedByAdmin({ userId: otherUserId, monthlyUsageUsed: 5, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await setMonthlyUsageUsedByAdmin({ userId: otherUserId, monthlyUsageUsed: 0, monthlyUsageLimit: 20, usagePeriod: PERIOD });
    await settleUsage({ userId: USER_ID, aiJobId: job.id, actualAmount: 18, providerCostUsdMicros: null, monthlyUsageLimit: 20, currentUsagePeriod: PERIOD });

    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(18);
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
