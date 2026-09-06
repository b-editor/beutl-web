import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  checkoutRetrieve: vi.fn(),
  deleteBoundProCheckoutAttempt: vi.fn(),
  findBillingOfferById: vi.fn(),
  findProCheckoutAttemptBySessionId: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findStripeCustomerOwnershipByStripeId: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  invoicePaymentList: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  refundCreate: vi.fn(),
  resolveProBillingOffer: vi.fn(),
  retrieveSubscription: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  startRetryableTransaction: vi.fn(),
  throwIfUnauth: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ throwIfUnauth: mocks.throwIfUnauth }));
vi.mock("@/lib/customer", () => ({
  createOrRetrieveOwnedCustomerId: vi.fn(),
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: { sessions: { retrieve: mocks.checkoutRetrieve } },
    invoicePayments: { list: mocks.invoicePaymentList },
    refunds: { create: mocks.refundCreate },
    subscriptions: {
      cancel: mocks.cancelSubscription,
      retrieve: mocks.retrieveSubscription,
    },
    paymentIntents: { retrieve: vi.fn() },
  }),
}));
vi.mock("@/lib/stripe/ai-billing", () => ({
  activateConfiguredProOffer: vi.fn(),
  activateConfiguredTopUpOffer: vi.fn(),
  blocksNewProCheckout: vi.fn(),
  fulfillOrRefundTopUpPayment: vi.fn(),
  configuredProPriceIds: () => {
    const result = new Set<string>();
    if (process.env.STRIPE_PRO_PRICE_ID) {
      result.add(process.env.STRIPE_PRO_PRICE_ID);
    }
    for (const entry of
      process.env.STRIPE_PRO_HISTORICAL_OFFERS?.split(",") ?? []) {
      const [priceId] = entry.split(":");
      if (priceId) result.add(priceId);
    }
    return result;
  },
  getSubscriptionPeriod: () => ({
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
  }),
  resolveProBillingOffer: mocks.resolveProBillingOffer,
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT:
    "pre-owner-metadata-2026-08-09",
  deleteBoundProCheckoutAttempt: mocks.deleteBoundProCheckoutAttempt,
  findBillingOfferById: mocks.findBillingOfferById,
  findCustomerByUserId: mocks.findCustomerByUserId,
  findProCheckoutAttemptBySessionId:
    mocks.findProCheckoutAttemptBySessionId,
  findStripeCustomerOwnershipByStripeId:
    mocks.findStripeCustomerOwnershipByStripeId,
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  reconcileSubscriptionObservation: mocks.reconcileSubscriptionObservation,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));

import { reconcileAiCheckoutSuccess } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/actions";

const ownerMetadata = {
  beutlApplication: "beutl-web",
  beutlUserId: "user-1",
  planId: "pro",
  billingOfferId: "offer_pro_v1",
};

const proOffer = {
  id: "offer_pro_v1",
  kind: "pro",
  stripePriceId: "price_pro",
  stripeProductId: "prod_pro",
  unitAmount: 2_000,
  currency: "usd",
  creditAmount: null,
  recurringInterval: "month",
  recurringIntervalCount: 1,
  checkoutEnabled: true,
};

const proItems = () => ({
  data: [{
    quantity: 1,
    price: {
      id: "price_pro",
      product: "prod_pro",
      unit_amount: 2_000,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    },
  }],
});

describe("AI Checkout return reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
    mocks.throwIfUnauth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });
    mocks.findStripeCustomerOwnershipByStripeId.mockResolvedValue({
      stripeId: "cus_1",
      userId: "user-1",
      migrationCohort: null,
      verifiedAt: new Date(),
    });
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_1",
    });
    mocks.findProCheckoutAttemptBySessionId.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-1",
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_verified",
    });
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.findBillingOfferById.mockResolvedValue(proOffer);
    mocks.reconcileSubscriptionObservation.mockResolvedValue({
      applied: true,
      subscription: { stripeSubscriptionId: "sub_1" },
    });
    mocks.resolveProBillingOffer.mockResolvedValue(proOffer);
    mocks.cancelSubscription.mockResolvedValue({ id: "sub_1", status: "canceled" });
    mocks.invoicePaymentList.mockResolvedValue({ data: [], has_more: false });
    mocks.refundCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
    mocks.scheduleBillingRefundAttempt.mockResolvedValue({ id: "bra_1" });
    mocks.recordBillingRefundCancellation.mockResolvedValue(true);
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({ transaction: true }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      created: 1_786_060_700,
      cancel_at_period_end: false,
      metadata: ownerMetadata,
      items: proItems(),
    });
  });

  it("rejects a return that does not contain a Stripe Checkout Session ID", async () => {
    await expect(reconcileAiCheckoutSuccess("forged")).resolves.toBe(false);
    expect(mocks.checkoutRetrieve).not.toHaveBeenCalled();
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("ignores an expired, forged, or inaccessible Checkout Session return", async () => {
    mocks.checkoutRetrieve.mockRejectedValue(new Error("No such checkout session"));

    await expect(
      reconcileAiCheckoutSuccess("cs_unavailable"),
    ).resolves.toBe(false);

    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.findProCheckoutAttemptBySessionId).not.toHaveBeenCalled();
  });

  it("reconciles the exact completed and owned Checkout Session", async () => {
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_verified",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: ownerMetadata,
    });

    await expect(
      reconcileAiCheckoutSuccess("cs_verified"),
    ).resolves.toBe(true);
    expect(mocks.checkoutRetrieve).toHaveBeenCalledWith("cs_verified");
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_1",
        billingOfferId: "offer_pro_v1",
        stripeEventId: "checkout:cs_verified",
      }),
    );
  });

  it("durably compensates a completed bound Checkout whose offer is no longer authorized", async () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_v2";
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_verified",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      invoice: "in_1",
      metadata: ownerMetadata,
    });
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_1",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_1" },
      }],
      has_more: false,
    });

    await expect(
      reconcileAiCheckoutSuccess("cs_verified"),
    ).resolves.toBe(false);

    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith({
      disposition: "superseded-pro-checkout",
      sourceKey: "cs_verified:pi_1",
      stripeCustomerId: "cus_1",
      stripeCheckoutSessionId: "cs_verified",
      stripeSubscriptionId: "sub_1",
      stripeInvoiceId: "in_1",
      stripePaymentIntentId: "pi_1",
      prisma: { transaction: true },
    });
    expect(mocks.cancelSubscription).toHaveBeenCalled();
    expect(mocks.resolveProBillingOffer).not.toHaveBeenCalled();
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.deleteBoundProCheckoutAttempt).toHaveBeenCalledWith({
      userId: "user-1",
      checkoutKey: "attempt-1",
      stripeCheckoutSessionId: "cs_verified",
    });
  });

  it("rejects a completed Session owned by another account", async () => {
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_verified",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: { ...ownerMetadata, beutlUserId: "user-2" },
    });

    await expect(
      reconcileAiCheckoutSuccess("cs_verified"),
    ).resolves.toBe(false);
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("cancels and refunds a completed Session for a superseded customer", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_current",
    });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_verified",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      invoice: "in_1",
      metadata: ownerMetadata,
    });
    mocks.invoicePaymentList.mockResolvedValue({
      data: [
        {
          id: "ip_1",
          amount_paid: 2_000,
          payment: { type: "payment_intent", payment_intent: "pi_1" },
        },
      ],
      has_more: false,
    });

    await expect(reconcileAiCheckoutSuccess("cs_verified")).resolves.toBe(false);

    expect(mocks.cancelSubscription).toHaveBeenCalledWith(
      "sub_1",
      { invoice_now: false, prorate: false },
      {
        idempotencyKey:
          "beutl:superseded-pro-checkout-cancel:cs_verified",
      },
    );
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith({
      disposition: "superseded-pro-checkout",
      sourceKey: "cs_verified:pi_1",
      stripeCustomerId: "cus_1",
      stripeCheckoutSessionId: "cs_verified",
      stripeSubscriptionId: "sub_1",
      stripeInvoiceId: "in_1",
      stripePaymentIntentId: "pi_1",
      prisma: { transaction: true },
    });
    expect(mocks.recordBillingRefundCancellation).toHaveBeenCalledWith({
      attemptId: "bra_1",
      now: expect.any(Date),
    });
    expect(mocks.refundCreate).not.toHaveBeenCalled();
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("orders Checkout success by subscription creation rather than session opening", async () => {
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_new",
      // The user opened Checkout before the old subscription was canceled.
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_new",
      metadata: ownerMetadata,
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      stripeSubscriptionId: "sub_old",
      status: "canceled",
      stripeEventCreatedAt: new Date(1_786_060_800_000),
    });
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_new",
      customer: "cus_1",
      status: "active",
      created: 1_786_060_901,
      cancel_at_period_end: false,
      metadata: ownerMetadata,
      items: proItems(),
    });
    mocks.reconcileSubscriptionObservation.mockResolvedValue({
      applied: true,
      subscription: { stripeSubscriptionId: "sub_new" },
    });

    await expect(reconcileAiCheckoutSuccess("cs_new")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_new",
        stripeEventCreatedAt: new Date(1_786_060_901_000),
        replaceExistingSubscription: true,
      }),
    );
  });

  it("rejects replay of an old success URL after a newer subscription is established", async () => {
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_old",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_old",
      metadata: ownerMetadata,
    });
    mocks.findProCheckoutAttemptBySessionId.mockResolvedValue(null);
    mocks.getSubscriptionByUserId.mockResolvedValue({
      stripeSubscriptionId: "sub_new",
      status: "active",
      stripeEventCreatedAt: new Date(1_786_060_900_000),
    });
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_old",
      customer: "cus_1",
      status: "canceled",
      created: 1_786_060_601,
      cancel_at_period_end: false,
      metadata: ownerMetadata,
      items: { data: [] },
    });

    await expect(reconcileAiCheckoutSuccess("cs_old")).resolves.toBe(false);
    expect(mocks.resolveProBillingOffer).not.toHaveBeenCalled();
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
  });

  it("treats reloading the same successful Session as idempotent", async () => {
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_verified",
      created: 1_786_060_600,
      status: "complete",
      payment_status: "paid",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: ownerMetadata,
    });
    mocks.findProCheckoutAttemptBySessionId.mockResolvedValue(null);
    mocks.getSubscriptionByUserId.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    mocks.reconcileSubscriptionObservation.mockResolvedValue({
      applied: false,
      subscription: { stripeSubscriptionId: "sub_1" },
    });

    await expect(
      reconcileAiCheckoutSuccess("cs_verified"),
    ).resolves.toBe(true);
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
  });
});
