import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  reschedule: vi.fn(),
  intervention: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  findBillingOfferById: vi.fn(),
  deleteStorageAttempt: vi.fn(),
  claimDetachedStorage: vi.fn(),
  completeDetachedStorage: vi.fn(),
  terminalDetachedStorage: vi.fn(),
  rescheduleDetachedStorage: vi.fn(),
  interventionDetachedStorage: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  listDueStripeCheckoutCleanups: mocks.listDue,
  claimStripeCheckoutCleanup: mocks.claim,
  completeStripeCheckoutCleanup: mocks.complete,
  rescheduleStripeCheckoutCleanup: mocks.reschedule,
  markStripeCheckoutCleanupIntervention: mocks.intervention,
  schedulePackagePaymentRefundAttempt: vi.fn(),
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  findBillingOfferById: mocks.findBillingOfferById,
  deletePackageCheckoutAttemptBySessionId: vi.fn(),
  claimDetachedPackageCheckoutAttempt: vi.fn().mockResolvedValue([]),
  claimDetachedSubscriptionCheckoutAttempts: mocks.claimDetachedStorage,
  completeDetachedSubscriptionCheckoutRecovery: mocks.completeDetachedStorage,
  deleteSubscriptionCheckoutAttemptBySessionId: mocks.deleteStorageAttempt,
  markDetachedSubscriptionCheckoutRecoveryIntervention: mocks.interventionDetachedStorage,
  markDetachedSubscriptionCheckoutRecoveryTerminal: mocks.terminalDetachedStorage,
  rescheduleDetachedSubscriptionCheckoutRecovery: mocks.rescheduleDetachedStorage,
  completeDetachedTopUpCheckoutRecovery: vi.fn(),
  bindDetachedPackageCheckoutRecovery: vi.fn(),
  markDetachedPackageCheckoutRecoveryTerminal: vi.fn(),
  bindDetachedPackageCheckoutRecoveryAndScheduleCleanup: vi.fn(),
  rescheduleDetachedPackageCheckoutRecovery: vi.fn(),
  markDetachedPackageCheckoutRecoveryIntervention: vi.fn(),
  claimUnboundTopUpCheckoutRecoveries: vi.fn().mockResolvedValue([]),
  clearDetachedTopUpCheckoutRecovery: vi.fn(),
  markDetachedTopUpCheckoutRecoveryIntervention: vi.fn(),
  setTopUpCheckoutSession: vi.fn(),
  claimPackageCheckoutInterventions: vi.fn().mockResolvedValue([]),
  markPackageCheckoutAttemptIntervention: vi.fn(),
  resolvePackageCheckoutAttemptIntervention: vi.fn(),
  recordPackageCheckoutResolution: vi.fn(),
  schedulePackageCheckoutResolutionRefunds: vi.fn(),
  packageCheckoutResolutionRefundState: vi.fn(),
  packageCheckoutResolutionRefundsSettled: vi.fn(),
  markPackageCheckoutResolutionResolved: vi.fn(),
  markPackageCheckoutResolutionIntervention: vi.fn(),
  findPackagePaymentReference: vi.fn(),
  reschedulePackageCheckoutIntervention: vi.fn(),
}));
import { reconcileStripeCheckoutCleanups } from "../../packages/api/src/ai/stripe-checkout-cleanups";

const NOW = new Date("2026-09-07T00:00:00Z");
const storageOffer = {
  id: "offer_100gb",
  kind: "storage",
  stripePriceId: "price_100",
  stripeProductId: "prod_100gb",
  tier: "100gb",
};

function completedStorageSession() {
  return {
    id: "cs_storage",
    status: "complete",
    mode: "subscription",
    customer: "cus_1",
    subscription: "sub_storage",
    invoice: "in_1",
    metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
    line_items: { data: [{ quantity: 1, price: { id: "price_100" } }] },
  };
}

describe("storage checkout cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDue.mockResolvedValue([]);
    mocks.claimDetachedStorage.mockResolvedValue([]);
    mocks.findBillingOfferById.mockResolvedValue(storageOffer);
    mocks.scheduleBillingRefundAttempt.mockResolvedValue({ id: "bra_1" });
    mocks.recordBillingRefundCancellation.mockResolvedValue(true);
  });

  it("cancels and refunds a completed storage Session bound to a deleted account", async () => {
    const row = { id: "c1", sessionId: "cs_storage", kind: "storage", userId: "u1", customerId: "cus_1", billingOfferId: "offer_100gb", packageId: null, attempts: 1 };
    mocks.listDue.mockResolvedValue([row]);
    mocks.claim.mockResolvedValue({ ...row, attempts: 2 });
    const cancel = vi.fn().mockResolvedValue({ id: "sub_storage", status: "canceled" });
    const client = {
      checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(completedStorageSession()), expire: vi.fn() } },
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({ id: "sub_storage", status: "active", customer: "cus_1", metadata: { billingOfferId: "offer_100gb" } }),
        cancel,
      },
      invoicePayments: { list: vi.fn().mockResolvedValue({ data: [{ payment: { payment_intent: "pi_1" } }], has_more: false }) },
      paymentIntents: { retrieve: vi.fn() },
    };

    const result = await reconcileStripeCheckoutCleanups(NOW, "sk_test", client as never);

    expect(cancel).toHaveBeenCalledWith("sub_storage", { invoice_now: false, prorate: false }, expect.anything());
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "account-delete-checkout-cleanup", stripeSubscriptionId: "sub_storage", stripePaymentIntentId: "pi_1" }),
    );
    expect(mocks.deleteStorageAttempt).toHaveBeenCalledWith({ stripeCheckoutSessionId: "cs_storage" });
    expect(result.completed).toBe(1);
  });

  it("refuses a cleanup row whose plan does not match the Session", async () => {
    const row = { id: "c2", sessionId: "cs_storage", kind: "pro", userId: "u1", customerId: "cus_1", billingOfferId: "offer_100gb", packageId: null, attempts: 1 };
    mocks.listDue.mockResolvedValue([row]);
    mocks.claim.mockResolvedValue({ ...row, attempts: 2 });
    const client = {
      checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(completedStorageSession()), expire: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
      invoicePayments: { list: vi.fn() },
      paymentIntents: { retrieve: vi.fn() },
    };

    const result = await reconcileStripeCheckoutCleanups(NOW, "sk_test", client as never);

    expect(client.subscriptions.cancel).not.toHaveBeenCalled();
    expect(mocks.reschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "c2", lastError: expect.stringContaining("plan mismatch") }));
    expect(result.pending).toBe(1);
  });

  it("replays a detached storage create under its own key and validates the tier", async () => {
    mocks.claimDetachedStorage.mockResolvedValue([
      {
        userId: "u1",
        planId: "storage",
        checkoutKey: "key-storage",
        billingOfferId: "offer_100gb",
        tier: "100gb",
        customerId: "cus_1",
        paramsJson: JSON.stringify({ mode: "subscription", customer: "cus_1" }),
        recoveryAttempts: 1,
      },
    ]);
    mocks.completeDetachedStorage.mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({
      id: "cs_recovered",
      status: "open",
      mode: "subscription",
      customer: "cus_1",
      metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
      line_items: { data: [{ price: { id: "price_100" } }] },
    });
    const client = {
      checkout: { sessions: { create, retrieve: vi.fn(), expire: vi.fn(), list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } },
      subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
      invoicePayments: { list: vi.fn() },
      paymentIntents: { retrieve: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", client as never);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription" }), { idempotencyKey: "storage-checkout:key-storage" });
    expect(mocks.completeDetachedStorage).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", planId: "storage", stripeCheckoutSessionId: "cs_recovered" }));
    expect(mocks.rescheduleDetachedStorage).not.toHaveBeenCalled();
  });

  it("reschedules a detached replay whose tier does not match", async () => {
    mocks.claimDetachedStorage.mockResolvedValue([
      {
        userId: "u1",
        planId: "storage",
        checkoutKey: "key-storage",
        billingOfferId: "offer_100gb",
        tier: "1tb",
        customerId: "cus_1",
        paramsJson: JSON.stringify({ mode: "subscription", customer: "cus_1" }),
        recoveryAttempts: 1,
      },
    ]);
    const client = {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: "cs_recovered",
            status: "open",
            mode: "subscription",
            customer: "cus_1",
            metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
            line_items: { data: [{ price: { id: "price_100" } }] },
          }),
          retrieve: vi.fn(),
          expire: vi.fn(),
          list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        },
      },
      subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
      invoicePayments: { list: vi.fn() },
      paymentIntents: { retrieve: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", client as never);

    expect(mocks.completeDetachedStorage).not.toHaveBeenCalled();
    expect(mocks.rescheduleDetachedStorage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", lastError: expect.stringContaining("canonical validation") }),
    );
  });
});
