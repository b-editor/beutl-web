import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAiJobForFinalization,
  claimAiJobForProviderPoll,
  getCreditAccount,
  setDbProvider,
  upsertSubscription,
} from "@beutl/db";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
  failFinalizingAiJobAndRefundUsage,
  failPolledAiJobAndRefundUsage,
} from "../../packages/api/src/ai/credits";
import { saveAiImage, setR2BucketProvider } from "../../packages/api/src/ai/storage";
import { startAiJobTransaction } from "../../packages/api/src/ai/transaction";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const userId = "ai-transaction-budget-user";
const options = { timeout: 30_000 };

describe("AI job transaction budgets", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  let transaction: ReturnType<typeof vi.spyOn>;
  let putObject: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    transaction = vi.spyOn(memory.prisma, "$transaction");
    putObject = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({ put: putObject, delete: vi.fn() }));
    await upsertSubscription({
      userId, stripeSubscriptionId: "sub_transaction_budget", status: "active", planId: "pro",
      billingOfferId: "offer_pro_test", currentPeriodStart: new Date("2026-01-01"), currentPeriodEnd: new Date("2099-01-01"),
    });
    transaction.mockClear();
  });

  async function reserve(kind = "image") {
    const result = await createReservedAiJob({ userId, kind, provider: "test", status: "running", usageUnits: 3.125 });
    if (!result.ok) throw new Error("Fixture reservation failed");
    return result.job;
  }

  it("allows the complete reservation ledger write to exceed Prisma's five-second default", async () => {
    await reserve();
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), options);
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(3.125);
  });

  it("gives output persistence and fractional settlement one bounded transaction", async () => {
    const job = await reserve();
    Object.assign(memory.state.aiJobs.get(job.id)!, { usageUnitUsdMicros: 10_000, estimatedUsageUnits: 2.5 });
    transaction.mockClear();
    putObject.mockImplementation(async () => {
      // Upload must finish before the retryable output transaction starts.
      expect(transaction).not.toHaveBeenCalled();
    });
    await saveAiImage({ userId, jobId: job.id, bytes: Uint8Array.from([1, 2, 3]).buffer, mimeType: "image/png", filename: "test.png", providerCostUsd: "0.00625" });

    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), options);
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(memory.state.aiJobs.get(job.id)).toMatchObject({ status: "succeeded", usageUnits: 0.625 });
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(0.625);
    expect(memory.state.creditTransactions.find(row => row.kind === "usage_settlement")).toMatchObject({ usageAmount: -2.5 });
  });

  it("keeps the extended budget on every serialization-conflict retry", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockImplementation(async callback => callback({}));
    setDbProvider(async () => ({ $transaction: execute }) as never);

    await expect(startAiJobTransaction(async () => "completed")).resolves.toBe("completed");
    expect(execute).toHaveBeenNthCalledWith(1, expect.any(Function), options);
    expect(execute).toHaveBeenNthCalledWith(2, expect.any(Function), options);
  });

  it("does not retry an expired transaction indefinitely", async () => {
    const error = Object.assign(new Error("expired transaction"), { code: "P2028" });
    const execute = vi.fn().mockRejectedValue(error);
    setDbProvider(async () => ({ $transaction: execute }) as never);

    await expect(startAiJobTransaction(async () => "unused")).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["synchronous", "finalizer", "poller"] as const)("uses the same budget for a %s failure and refund", async (owner) => {
    const job = await reserve(owner === "synchronous" ? "image" : "video");
    const providerJobId = `provider-${job.id}`;
    memory.state.aiJobs.get(job.id)!.providerJobId = providerJobId;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    if (owner === "finalizer") {
      const claim = await claimAiJobForFinalization({ jobId: job.id, now, leaseExpiresAt });
      if (!claim.claimed) throw new Error("Fixture finalizer claim failed");
      await failFinalizingAiJobAndRefundUsage({ userId, aiJobId: job.id, finalizationToken: claim.finalizationToken, expectedProviderJobId: providerJobId, error: "test failure" });
    } else if (owner === "poller") {
      await claimAiJobForProviderPoll({ jobId: job.id, now, leaseExpiresAt });
      await failPolledAiJobAndRefundUsage({ userId, aiJobId: job.id, providerPollLeaseExpiresAt: leaseExpiresAt, expectedProviderJobId: providerJobId, error: "test failure" });
    } else {
      await failAiJobAndRefundUsage({ userId, aiJobId: job.id, error: "test failure" });
    }

    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), options);
    expect(memory.state.aiJobs.get(job.id)?.status).toBe("failed");
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(0);
    expect(memory.state.creditTransactions.filter(row => row.kind === "refund")).toHaveLength(1);
  });
});
