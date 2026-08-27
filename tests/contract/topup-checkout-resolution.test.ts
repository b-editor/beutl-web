import { describe, expect, it, vi } from "vitest";
import { recordTopUpCheckoutResolution, finalizeTopUpCheckoutResolutionAtomically } from "../../packages/db/src/topup-checkout-resolution";

describe("TopUp checkout resolution", () => {
  it("rejects immutable identity conflicts", async () => {
    const db = { topUpCheckoutResolution: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "other", stripeCustomerId: "cus", billingOfferId: "offer", status: "refund_pending", expectedPaymentIntentIds: "[]", revision: 0 }), updateMany: vi.fn() } };
    await expect(recordTopUpCheckoutResolution({ topUpAttemptId: "a1", ownerUserId: "u1", stripeCustomerId: "cus", billingOfferId: "offer", expectedPaymentIntentIds: [], prisma: db as never })).rejects.toThrow("identity conflict");
  });

  it("atomically binds the canonical Session and resolves the row", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { topUpCheckoutResolution: { findUnique: vi.fn().mockResolvedValue({ id: "r1", status: "refund_pending", revision: 0 }), updateMany }, topUpDuplicateRefundAttempt: { findMany: vi.fn().mockResolvedValue([]) }, topUpCheckoutAttempt: { findUnique: vi.fn().mockResolvedValue({ recoveryLeaseToken: "lease", createLeaseToken: "lease", stripeCheckoutSessionId: null, accountDeletionAt: null, status: "open", updatedAt: new Date() }), updateMany } };
    await expect(finalizeTopUpCheckoutResolutionAtomically({ topUpAttemptId: "a1", recoveryLeaseToken: "lease", finalization: { outcome: "bind", sessionId: "cs1", expiresAt: new Date() }, prisma: tx as never })).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
