import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), retry: vi.fn(), intervention: vi.fn(), resume: vi.fn(), retrieve: vi.fn(), list: vi.fn(), create: vi.fn() }));
vi.mock("@beutl/db", () => ({ claimTopUpDuplicateRefundAttempts: mocks.claim, completeTopUpDuplicateRefundAttempt: mocks.complete, rescheduleTopUpDuplicateRefundAttempt: mocks.retry, markTopUpDuplicateRefundIntervention: mocks.intervention, resumeSettledTopUpCheckoutInterventions: mocks.resume }));
import { reconcileTopUpDuplicateRefunds } from "../../packages/api/src/ai/topup-duplicate-refunds";

describe("top-up duplicate refund production reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue({ count: 1 });
    mocks.retry.mockResolvedValue({ count: 1 });
    mocks.intervention.mockResolvedValue({ count: 1 });
    mocks.resume.mockResolvedValue(0);
    mocks.claim.mockResolvedValue([{
      id: "r1",
      topUpAttemptId: "a",
      stripePaymentIntentId: "pi-1",
      stripeCustomerId: "cus",
      ownerUserId: "u",
      billingOfferId: "offer",
      amount: 100,
      currency: "usd",
      attempts: 1,
      claimKind: "automatic",
      interventionAt: null,
    }]);
  });
  it("keeps a pending refund retryable and never creates another refund", async () => {
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValueOnce({ data: [{ id: "re-pending", amount: 100, status: "pending" }], has_more: false });
    const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
    expect(result.pending).toBe(1); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.retry).toHaveBeenCalled();
  });
  it.each(["requires_action", "unknown"]) ("reserves %s refunds and never creates a duplicate", async (status) => {
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValueOnce({ data: [{ id: `re-${status}`, amount: 100, status }], has_more: false });
    const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
    expect(result.pending).toBe(1); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("handles paginated refunds and settles on the next tick", async () => {
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValueOnce({ data: [{ id: "re-failed", amount: 50, status: "failed" }], has_more: true }).mockResolvedValueOnce({ data: [{ id: "re-succeeded", amount: 100, status: "succeeded" }], has_more: false });
    const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
    expect(result.pending + result.completed).toBe(1); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("keeps failed-refund idempotency generations bounded", async () => {
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValue({ data: Array.from({ length: 100 }, (_, index) => ({ id: `failed-${index}`, amount: 1, status: "failed" })), has_more: false });
    mocks.create.mockResolvedValue({ id: "new", amount: 100, status: "succeeded" });
    await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
    const key = mocks.create.mock.calls[0]?.[1]?.idempotencyKey as string;
    expect(key.length).toBeLessThan(255);
    expect(key).toContain(":0:100:100");
  });
  it("does not report an already-refunded row completed when the lease CAS is lost", async () => {
    mocks.complete.mockResolvedValue({ count: 0 });
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValue({ data: [{ id: "re-existing", amount: 100, status: "succeeded" }], has_more: false });

    const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
    expect(result).toMatchObject({ completed: 0, pending: 0, interventionRequired: 0 });
  });
  it("does not report a newly-created refund completed when the lease CAS is lost", async () => {
    mocks.complete.mockResolvedValue({ count: 0 });
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValue({ data: [], has_more: false });
    mocks.create.mockResolvedValue({ id: "re-new", amount: 100, status: "succeeded" });

    await expect(reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never)).resolves.toMatchObject({ completed: 0, pending: 0, interventionRequired: 0 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.intervention).not.toHaveBeenCalled();
  });

  it.each(["pending", "requires_action", "failed", "canceled"])(
    "caps a newly-created %s refund instead of scheduling attempt thirteen",
    async (status) => {
      const claimed = {
        id: "r1",
        topUpAttemptId: "a",
        stripePaymentIntentId: "pi-1",
        stripeCustomerId: "cus",
        ownerUserId: "u",
        billingOfferId: "offer",
        amount: 100,
        currency: "usd",
        attempts: 11,
        claimKind: "automatic",
        interventionAt: null,
      };
      mocks.claim
        .mockResolvedValueOnce([claimed])
        .mockResolvedValueOnce([{ ...claimed, attempts: 12 }]);
      mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
      mocks.list
        .mockResolvedValueOnce({ data: [], has_more: false })
        .mockResolvedValueOnce({
          data: [{ id: "re-capped", amount: 100, status }],
          has_more: false,
        });
      mocks.create.mockResolvedValue({ id: "re-capped", amount: 100, status });

      const first = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);
      const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);

      expect(first.pending).toBe(1);
      expect(result).toMatchObject({ interventionRequired: 1, pending: 0 });
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.intervention).toHaveBeenCalled();
    },
  );

  it("keeps a reclaimed crashed intervention in canonical-recheck mode", async () => {
    mocks.claim.mockResolvedValueOnce([{
      id: "r1",
      topUpAttemptId: "a",
      stripePaymentIntentId: "pi-1",
      stripeCustomerId: "cus",
      ownerUserId: "u",
      billingOfferId: "offer",
      amount: 100,
      currency: "usd",
      attempts: 12,
      claimKind: "canonical-recheck",
      interventionAt: new Date("2026-08-25T00:00:00Z"),
    }]);
    mocks.retrieve.mockResolvedValue({ status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus", metadata: { topUpAttemptId: "a", beutlUserId: "u", billingOfferId: "offer" } });
    mocks.list.mockResolvedValue({ data: [], has_more: false });

    const result = await reconcileTopUpDuplicateRefunds(new Date(), "sk", { paymentIntents: { retrieve: mocks.retrieve }, refunds: { list: mocks.list, create: mocks.create } } as never);

    expect(result.interventionRequired).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.intervention).toHaveBeenCalled();
  });
});
