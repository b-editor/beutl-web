import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCreditAccount, setDbProvider, upsertSubscription } from "@beutl/db";
import { createReservedAiJob } from "../../packages/api/src/ai/credits";
import { quoteAiUsageReservation } from "../../packages/api/src/ai/usage-cost";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/usage-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/api/src/ai/usage-cost")>()),
  quoteAiUsageReservation: vi.fn(),
}));

const request = {
  userId: "pricing-replay-user",
  kind: "image",
  provider: "openrouter",
  status: "running" as const,
  // No catalog entry remains to supply a legacy fixed-price fallback.
  model: "review/retired-model",
  idempotencyKeyHash: "pricing-replay-key",
  requestFingerprint: "original-body",
  activeJobLimit: 1,
};

describe("reservation replay without current pricing", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(async () => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    vi.mocked(quoteAiUsageReservation).mockReset();
    vi.mocked(quoteAiUsageReservation).mockResolvedValue(null);
    await upsertSubscription({
      userId: request.userId,
      stripeSubscriptionId: "sub_pricing_replay",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
  });

  async function reserveOriginal() {
    const result = await createReservedAiJob({ ...request, usageUnits: 0.25 });
    if (!result.ok) throw new Error("Fixture reservation failed");
    return memory.state.aiJobs.get(result.job.id)!;
  }

  it.each(["running", "succeeded"])("recovers a %s job without charging twice", async (status) => {
    const job = await reserveOriginal();
    job.status = status;

    expect(await createReservedAiJob(request)).toMatchObject({
      ok: true,
      outcome: "existing",
      job: { id: job.id, status },
    });
    expect(memory.state.aiJobs.size).toBe(1);
    expect(memory.state.creditTransactions).toHaveLength(1);
    expect((await getCreditAccount({ userId: request.userId })).monthlyUsageUsed).toBe(0.25);
  });

  it("preserves fingerprint conflicts when no quote is available", async () => {
    await reserveOriginal();
    expect(await createReservedAiJob({ ...request, requestFingerprint: "changed-body" })).toEqual({
      ok: false, errorCode: "aiRequestChanged", status: 409,
    });
    expect(memory.state.creditTransactions).toHaveLength(1);
  });

  it("preserves deleted-job responses when no quote is available", async () => {
    const job = await reserveOriginal();
    job.deletedAt = new Date();
    expect(await createReservedAiJob(request)).toEqual({
      ok: false, errorCode: "aiRequestWasDeleted", status: 409,
    });
    expect(memory.state.creditTransactions).toHaveLength(1);
  });

  it("accepts an existing compatible fingerprint without a quote", async () => {
    const job = await reserveOriginal();
    expect(await createReservedAiJob({
      ...request,
      requestFingerprint: "canonical-body",
      compatibleRequestFingerprints: [request.requestFingerprint],
    })).toMatchObject({ ok: true, outcome: "existing", job: { id: job.id } });
    expect(memory.state.creditTransactions).toHaveLength(1);
  });

  it("recovers a reservation committed while the pricing lookup was in flight", async () => {
    vi.mocked(quoteAiUsageReservation).mockImplementationOnce(async () => {
      await reserveOriginal();
      return null;
    });
    expect(await createReservedAiJob(request)).toMatchObject({ ok: true, outcome: "existing" });
    expect(memory.state.aiJobs.size).toBe(1);
    expect(memory.state.creditTransactions).toHaveLength(1);
  });

  it("still rejects a new request without a quote or fallback", async () => {
    expect(await createReservedAiJob(request)).toEqual({
      ok: false, errorCode: "aiProviderCostUnavailable", status: 503,
    });
    expect(memory.state.aiJobs.size).toBe(0);
    expect(memory.state.creditTransactions).toHaveLength(0);
  });
});
