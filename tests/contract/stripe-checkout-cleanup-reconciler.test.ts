import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  reschedule: vi.fn(),
  intervention: vi.fn(),
  retrieveSession: vi.fn(),
  expire: vi.fn(),
  paymentRetrieve: vi.fn(),
  scheduleRefund: vi.fn(),
  claimDetached: vi.fn(),
  claimDetachedPro: vi.fn(),
  completeDetachedPro: vi.fn(),
  completeDetachedTopUp: vi.fn(),
  bindDetached: vi.fn(),
  bindDetachedAtomic: vi.fn(),
  terminalDetached: vi.fn(),
  rescheduleDetached: vi.fn(),
  interventionDetached: vi.fn(),
  detachedTopUps: vi.fn(),
  clearDetachedTopUp: vi.fn(),
  topUpIntervention: vi.fn(),
  setTopUpSession: vi.fn(),
  deleteAttempt: vi.fn(),
  claimInterventions: vi.fn(),
  markIntervention: vi.fn(),
  resolveIntervention: vi.fn(),
  recordResolution: vi.fn(),
  scheduleResolutionRefunds: vi.fn(),
  resolutionRefundState: vi.fn(),
  resolutionRefundsSettled: vi.fn(),
  markResolutionResolved: vi.fn(),
  markResolutionIntervention: vi.fn(),
  findPackagePaymentReference: vi.fn(),
  rescheduleIntervention: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  listDueStripeCheckoutCleanups: mocks.listDue,
  claimStripeCheckoutCleanup: mocks.claim,
  completeStripeCheckoutCleanup: mocks.complete,
  rescheduleStripeCheckoutCleanup: mocks.reschedule,
  markStripeCheckoutCleanupIntervention: mocks.intervention,
  schedulePackagePaymentRefundAttempt: mocks.scheduleRefund,
  scheduleBillingRefundAttempt: mocks.scheduleRefund,
  deleteProCheckoutAttemptBySessionId: mocks.deleteAttempt,
  deletePackageCheckoutAttemptBySessionId: mocks.deleteAttempt,
  claimDetachedPackageCheckoutAttempt: mocks.claimDetached,
  claimDetachedProCheckoutAttempts: mocks.claimDetachedPro,
  completeDetachedProCheckoutRecovery: mocks.completeDetachedPro,
  completeDetachedTopUpCheckoutRecovery: mocks.completeDetachedTopUp,
  bindDetachedPackageCheckoutRecovery: mocks.bindDetached,
  markDetachedPackageCheckoutRecoveryTerminal: mocks.terminalDetached,
  bindDetachedPackageCheckoutRecoveryAndScheduleCleanup: mocks.bindDetachedAtomic,
  rescheduleDetachedPackageCheckoutRecovery: mocks.rescheduleDetached,
  markDetachedPackageCheckoutRecoveryIntervention: mocks.interventionDetached,
  claimUnboundTopUpCheckoutRecoveries: mocks.detachedTopUps,
  clearDetachedTopUpCheckoutRecovery: mocks.clearDetachedTopUp,
  markDetachedTopUpCheckoutRecoveryIntervention: mocks.topUpIntervention,
  setTopUpCheckoutSession: mocks.setTopUpSession,
  claimPackageCheckoutInterventions: mocks.claimInterventions,
  markPackageCheckoutAttemptIntervention: mocks.markIntervention,
  resolvePackageCheckoutAttemptIntervention: mocks.resolveIntervention,
  recordPackageCheckoutResolution: mocks.recordResolution,
  schedulePackageCheckoutResolutionRefunds: mocks.scheduleResolutionRefunds,
  packageCheckoutResolutionRefundState: mocks.resolutionRefundState,
  packageCheckoutResolutionRefundsSettled: mocks.resolutionRefundsSettled,
  markPackageCheckoutResolutionResolved: mocks.markResolutionResolved,
  markPackageCheckoutResolutionIntervention: mocks.markResolutionIntervention,
  findPackagePaymentReference: mocks.findPackagePaymentReference,
  reschedulePackageCheckoutIntervention: mocks.rescheduleIntervention,
}));
import { reconcileStripeCheckoutCleanups } from "../../packages/api/src/ai/stripe-checkout-cleanups";

describe("Stripe Checkout cleanup reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimDetached.mockResolvedValue([]);
    mocks.claimInterventions.mockResolvedValue([]);
    mocks.claimDetachedPro.mockResolvedValue([]);
    mocks.detachedTopUps.mockResolvedValue([]);
    mocks.listDue.mockResolvedValue([{ id: "c1", sessionId: "cs_1", kind: "package", userId: "u1", packageId: "p1", customerId: "cus_1", attempts: 1 }]);
    mocks.claim.mockResolvedValue({ id: "c1", sessionId: "cs_1", kind: "package", userId: "u1", packageId: "p1", customerId: "cus_1", attempts: 2 });
    mocks.retrieveSession.mockResolvedValue({ id: "cs_1", status: "open", customer: "cus_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } });
    mocks.bindDetachedAtomic.mockResolvedValue(true);
    mocks.recordResolution.mockResolvedValue({});
    mocks.scheduleResolutionRefunds.mockResolvedValue({});
    mocks.resolutionRefundState.mockResolvedValue("settled");
    mocks.resolutionRefundsSettled.mockResolvedValue(true);
    mocks.markResolutionResolved.mockResolvedValue({ count: 1 });
    mocks.rescheduleIntervention.mockResolvedValue({ count: 1 });
    mocks.findPackagePaymentReference.mockResolvedValue({ fulfillmentValidated: true, revokedAt: null });
    mocks.claimDetached.mockResolvedValue([]);
  });

  it("expires open sessions and completes only after remote resolution", async () => {
    mocks.expire.mockResolvedValue({ id: "cs_1", status: "expired" });
    const result = await reconcileStripeCheckoutCleanups(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      checkout: { sessions: { retrieve: mocks.retrieveSession, expire: mocks.expire } },
      paymentIntents: { retrieve: mocks.paymentRetrieve },
    } as never);
    expect(mocks.listDue).toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalled();
    expect(mocks.expire).toHaveBeenCalledWith("cs_1");
    expect(mocks.complete).toHaveBeenCalledWith({ id: "c1", leaseToken: expect.any(String) });
    expect(result.completed).toBe(1);
  });

  it("replays a response-lost detached create with its exact key and atomically records cleanup", async () => {
    mocks.listDue.mockResolvedValue([]);
    mocks.claimDetached.mockResolvedValue([{ id: "a1", discoveryToken: "a1", createdAt: new Date("2026-08-25T00:00:00Z"), userId: "u1", packageId: "p1", customerId: "cus_1", paramsJson: JSON.stringify({ mode: "payment", customer: "cus_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1", packageCheckoutAttemptId: "a1" } }), checkoutKey: "key-1", recoveryAttempts: 1 }]);
    mocks.retrieveSession.mockResolvedValue({ id: "cs_recovered", status: "open", customer: "cus_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" }, amount_total: null, currency: null });
    const client = {
      checkout: { sessions: { create: vi.fn().mockResolvedValue({ id: "cs_recovered", status: "open", mode: "payment", customer: "cus_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1", packageCheckoutAttemptId: "a1" }, amount_total: null, currency: null }), retrieve: mocks.retrieveSession, expire: mocks.expire, list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
    };
    await reconcileStripeCheckoutCleanups(new Date("2026-08-25T00:00:00Z"), "sk_test", client as never);
    expect(mocks.claimInterventions).toHaveBeenCalled();
    expect(client.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "payment" }), expect.objectContaining({ idempotencyKey: "key-1", timeout: expect.any(Number), maxNetworkRetries: 2 }));
    expect(mocks.rescheduleDetached).not.toHaveBeenCalled();
    expect(mocks.bindDetachedAtomic).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", stripeCheckoutSessionId: "cs_recovered" }));
  });

  it("hydrates multiple completed Sessions and schedules noncanonical refund through production reconciliation", async () => {
    mocks.listDue.mockResolvedValue([]);
    mocks.claimInterventions.mockResolvedValue([{
      id: "intervention-1", discoveryToken: "token-1", createdAt: new Date("2026-08-25T00:00:00Z"),
      userId: "u1", packageId: "p1", customerId: "cus_1", accountDeletionAt: null,
      paramsJson: JSON.stringify({ line_items: [{ price_data: { unit_amount: 500, currency: "usd" } }], metadata: { packageCheckoutAttemptId: "token-1" } }),
      expiresAt: new Date("2026-08-26T00:00:00Z"),
    }]);
    const sessions = [
      { id: "cs_a", status: "complete", customer: "cus_1", amount_total: 500, currency: "usd", payment_intent: "pi_a", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1", packageCheckoutAttemptId: "token-1" } },
      { id: "cs_b", status: "complete", customer: "cus_1", amount_total: 500, currency: "usd", payment_intent: "pi_b", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1", packageCheckoutAttemptId: "token-1" } },
    ];
    mocks.findPackagePaymentReference.mockResolvedValue({ fulfillmentValidated: true, revokedAt: null });
    const client = {
      checkout: { sessions: { list: vi.fn(async ({ status }: { status: string }) => ({ data: status === "complete" ? sessions : [], has_more: false })), retrieve: mocks.retrieveSession, expire: mocks.expire } },
      paymentIntents: { retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded", amount: 500, amount_received: 500, currency: "usd", customer: "cus_1", created: id === "pi_a" ? 1 : 2, metadata: { beutlPurchaseKind: "package", beutlUserId: "u1", packageId: "p1" }, latest_charge: { id: `ch_${id}`, created: id === "pi_a" ? 1 : 2 } })) },
      refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
    };
    await reconcileStripeCheckoutCleanups(new Date("2026-08-25T00:00:00Z"), "sk_test", client as never);
    expect(mocks.claimInterventions).toHaveBeenCalled();
  });
});
