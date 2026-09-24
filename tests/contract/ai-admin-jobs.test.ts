import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_USAGE_ESTIMATE_FINAL_KIND,
  adminAiJobBillingState,
  consumeUsage,
  createAiJob,
  listAdminAiJobs,
  markAiJobSucceeded,
  setDbProvider,
  settleUsage,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const PERIOD = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};

describe("admin AI job list", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function reserve(userId: string, kind = "image") {
    const job = await createAiJob({
      userId, kind, provider: "vercel-gateway", model: "test/model",
      status: "running", usageUnits: 10, reservedUsageUnits: 10,
      usageUnitUsdMicros: 10_000, estimatedUsageUnits: 8,
    });
    await consumeUsage({
      userId, amount: 10, monthlyUsageLimit: 100,
      usagePeriod: PERIOD, aiJobId: job.id,
    });
    return job;
  }

  it("lists all users with stable pages and only billing-safe metadata", async () => {
    const first = await reserve("user-a");
    await markAiJobSucceeded({ jobId: first.id });
    await settleUsage({
      userId: "user-a", aiJobId: first.id, actualAmount: 8,
      providerCostUsdMicros: null, finalEstimatedProviderCost: true,
      monthlyUsageLimit: 100, currentUsagePeriod: PERIOD,
    });
    vi.setSystemTime(new Date("2026-09-24T10:01:00.000Z"));
    const second = await reserve("user-b", "video");
    await markAiJobSucceeded({ jobId: second.id });
    await settleUsage({
      userId: "user-b", aiJobId: second.id, actualAmount: 6,
      providerCostUsdMicros: 60_000, monthlyUsageLimit: 100,
      currentUsagePeriod: PERIOD,
    });
    vi.setSystemTime(new Date("2026-09-24T10:02:00.000Z"));
    const third = await reserve("user-c");

    const firstPage = await listAdminAiJobs({ limit: 2 });
    expect(firstPage.jobs.map((job) => [job.id, job.billingState])).toEqual([
      [third.id, "not_settled"], [second.id, "actual"],
    ]);
    expect(firstPage.nextCursor).toEqual({ createdAt: second.createdAt, id: second.id });
    expect(firstPage.jobs[0]).not.toHaveProperty("inputParams");
    expect(firstPage.jobs[0]).not.toHaveProperty("providerJobId");
    expect(firstPage.jobs[0]).not.toHaveProperty("error");

    const secondPage = await listAdminAiJobs({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.jobs.map((job) => [job.id, job.billingState])).toEqual([
      [first.id, "estimated"],
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(firstPage.jobs[0].userId).toBe("user-c");
  });

  it("filters estimated charges without mixing in actual or unknown costs", async () => {
    const estimate = await reserve("user-a");
    await markAiJobSucceeded({ jobId: estimate.id });
    await settleUsage({
      userId: "user-a", aiJobId: estimate.id, actualAmount: 8,
      providerCostUsdMicros: null, finalEstimatedProviderCost: true,
      monthlyUsageLimit: 100, currentUsagePeriod: PERIOD,
    });
    const actual = await reserve("user-b");
    await markAiJobSucceeded({ jobId: actual.id });
    await settleUsage({
      userId: "user-b", aiJobId: actual.id, actualAmount: 6,
      providerCostUsdMicros: 60_000, monthlyUsageLimit: 100,
      currentUsagePeriod: PERIOD,
    });
    const unknown = await reserve("user-c");
    await markAiJobSucceeded({ jobId: unknown.id });
    memory.state.aiJobs.get(unknown.id)!.usageSettledAt = new Date();

    expect((await listAdminAiJobs({ limit: 50, billing: "estimated" })).jobs.map((job) => job.id))
      .toEqual([estimate.id]);
    expect((await listAdminAiJobs({ limit: 50, billing: "actual" })).jobs.map((job) => job.id))
      .toEqual([actual.id]);
    expect((await listAdminAiJobs({ limit: 50, billing: "unknown" })).jobs.map((job) => job.id))
      .toEqual([unknown.id]);
    expect((await listAdminAiJobs({ limit: 50, billing: "estimated", userId: "user-b" })).jobs)
      .toEqual([]);
    expect(memory.state.creditTransactions.some((row) =>
      row.aiJobId === estimate.id && row.kind === AI_USAGE_ESTIMATE_FINAL_KIND)).toBe(true);
  });

  it("does not claim an unmarked or overflowed audit value is actual cost", () => {
    const base = {
      status: "succeeded", usageUnitUsdMicros: 10_000,
      usageSettledAt: new Date(), providerCostUsdMicros: null,
      transactions: [] as { kind: string }[],
    };
    expect(adminAiJobBillingState(base)).toBe("unknown");
    expect(adminAiJobBillingState({ ...base, transactions: [{ kind: AI_USAGE_ESTIMATE_FINAL_KIND }] }))
      .toBe("estimated");
    expect(adminAiJobBillingState({ ...base, providerCostUsdMicros: 0 })).toBe("actual");
  });

  it("keeps equal-timestamp pages stable and distinguishes pending from legacy", async () => {
    const pending = await reserve("user-a");
    await markAiJobSucceeded({ jobId: pending.id });
    const legacy = await createAiJob({
      userId: "user-b", kind: "stt", provider: "openrouter",
      status: "running", usageUnits: 5,
    });
    await markAiJobSucceeded({ jobId: legacy.id });

    const orderedIds = [pending.id, legacy.id].sort().reverse();
    const page1 = await listAdminAiJobs({ limit: 1 });
    const page2 = await listAdminAiJobs({ limit: 1, cursor: page1.nextCursor! });
    expect([page1.jobs[0].id, page2.jobs[0].id]).toEqual(orderedIds);
    expect(page2.nextCursor).toBeNull();
    expect((await listAdminAiJobs({ limit: 50, billing: "pending" })).jobs.map((job) => job.id))
      .toEqual([pending.id]);
    expect((await listAdminAiJobs({ limit: 50, billing: "legacy" })).jobs.map((job) => job.id))
      .toEqual([legacy.id]);
    expect((await listAdminAiJobs({ limit: 50, billing: "pending", status: "failed" })).jobs)
      .toEqual([]);
  });
});
