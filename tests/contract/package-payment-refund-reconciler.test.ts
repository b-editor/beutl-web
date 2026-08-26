import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  reschedule: vi.fn(),
  intervention: vi.fn(),
  retrieve: vi.fn(),
  refundsList: vi.fn(),
  refundsCreate: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  listDuePackagePaymentRefundAttempts: mocks.listDue,
  claimPackagePaymentRefundAttempt: mocks.claim,
  completePackagePaymentRefundAttempt: mocks.complete,
  reschedulePackagePaymentRefundAttempt: mocks.reschedule,
  markPackagePaymentRefundIntervention: mocks.intervention,
}));
import { reconcilePackagePaymentRefunds } from "../../packages/api/src/ai/package-payment-refunds";

describe("package payment refund reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue({ count: 1 });
    mocks.listDue.mockResolvedValue([{ id: "r1", paymentIntentId: "pi_1", amount: 100, currency: "usd", attempts: 1 }]);
    mocks.claim.mockResolvedValue({ id: "r1", paymentIntentId: "pi_1", amount: 100, currency: "usd", attempts: 2, userId: "u1", packageId: "p1", customerId: "cus_1" });
    mocks.retrieve.mockResolvedValue({ id: "pi_1", amount: 100, currency: "usd", customer: "cus_1", metadata: { beutlPurchaseKind: "package", beutlUserId: "u1", packageId: "p1" } });
    mocks.refundsList.mockResolvedValue({ data: [] });
    mocks.refundsCreate.mockResolvedValue({ status: "pending" });
  });

  it("keeps pending Stripe refunds retryable and validates exact ownership", async () => {
    const result = await reconcilePackagePaymentRefunds(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      paymentIntents: { retrieve: mocks.retrieve },
      refunds: { list: mocks.refundsList, create: mocks.refundsCreate },
    } as never);
    expect(result.pending).toBe(1);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.reschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  });

  it("rotates the key after a definitively failed refund while preserving amount", async () => {
    mocks.claim.mockResolvedValue({ id: "r1", paymentIntentId: "pi_1", amount: 100, currency: "usd", attempts: 2, userId: "u1", packageId: "p1", customerId: "cus_1" });
    mocks.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus_1", metadata: { beutlPurchaseKind: "package", beutlUserId: "u1", packageId: "p1" } });
    mocks.refundsList.mockResolvedValue({ data: [{ id: "re_failed", amount: 100, status: "failed" }], has_more: false });
    mocks.refundsCreate.mockResolvedValue({ status: "succeeded" });
    const result = await reconcilePackagePaymentRefunds(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      paymentIntents: { retrieve: mocks.retrieve },
      refunds: { list: mocks.refundsList, create: mocks.refundsCreate },
    } as never);
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100 }),
      { idempotencyKey: "beutl:package-payment-refund:r1:0:1:100" },
    );
    expect(result.refunded).toBe(1);
  });

  it("reserves requires_action refunds instead of creating a duplicate", async () => {
    mocks.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 100, amount_received: 100, currency: "usd", customer: "cus_1", metadata: { beutlPurchaseKind: "package", beutlUserId: "u1", packageId: "p1" } });
    mocks.refundsList.mockResolvedValue({ data: [{ id: "re_action", amount: 100, status: "requires_action" }], has_more: false });
    const result = await reconcilePackagePaymentRefunds(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      paymentIntents: { retrieve: mocks.retrieve },
      refunds: { list: mocks.refundsList, create: mocks.refundsCreate },
    } as never);
    expect(result.pending).toBe(1);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });
});
