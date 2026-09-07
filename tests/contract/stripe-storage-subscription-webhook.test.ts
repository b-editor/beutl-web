import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  listCheckoutSessions: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrievePrice: vi.fn(),
  findCustomerByStripeId: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  activateBillingOffer: vi.fn(),
  registerHistoricalBillingOffer: vi.fn(),
  getSubscription: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  deleteSubscriptionCheckoutAttempt: vi.fn(),
}));

vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: vi.fn(),
  auditLogActions: { store: { paymentSucceeded: "store.paymentSucceeded" } },
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: { sessions: { list: mocks.listCheckoutSessions } },
    disputes: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    prices: { retrieve: mocks.retrievePrice },
    refunds: { retrieve: vi.fn() },
    subscriptions: { retrieve: mocks.retrieveSubscription },
    webhooks: { constructEvent: mocks.constructEvent },
  }),
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT: "pre-owner-metadata-2026-08-09",
  activateBillingOffer: mocks.activateBillingOffer,
  registerHistoricalBillingOffer: mocks.registerHistoricalBillingOffer,
  addPurchasedCredits: vi.fn(),
  createUserPackage: vi.fn(),
  createUserPaymentHistory: vi.fn(),
  deleteSubscriptionCheckoutAttempt: mocks.deleteSubscriptionCheckoutAttempt,
  existsCreditTransactionByStripePaymentId: vi.fn(),
  existsUserPaymentHistoryByPaymentId: vi.fn(),
  findCustomerByStripeId: mocks.findCustomerByStripeId,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  findPackageIdById: vi.fn(),
  getSubscription: mocks.getSubscription,
  listSubscriptionsByUserId: vi.fn().mockResolvedValue([]),
  reconcileSubscriptionObservation: mocks.reconcileSubscriptionObservation,
  reconcilePurchasedCreditReversal: vi.fn(),
}));

import { POST } from "../../apps/web/src/app/api/stripe/webhook/route";

const OWNER = { beutlApplication: "beutl-web", beutlUserId: "user-1" };
const TIER_BY_PRICE: Record<string, string> = {
  price_100: "100gb",
  price_200: "200gb",
  price_1tb: "1tb",
};

function request(): Request {
  return new Request("https://beutl.example/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "signature" },
    body: "{}",
  });
}

function offerFor(priceId: string) {
  const tier = TIER_BY_PRICE[priceId];
  return {
    id: `offer_${tier}`,
    kind: "storage",
    stripePriceId: priceId,
    stripeProductId: `prod_${tier}`,
    unitAmount: 500,
    currency: "usd",
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
    tier: tier,
    checkoutEnabled: true,
  };
}

function subscription({
  id = "sub_storage",
  priceId = "price_100",
  status = "active",
  planId = "storage",
  created = 1_700_000_000,
  cancelAt = null as number | null,
  customer = "cus_1",
}: Partial<{
  id: string;
  priceId: string;
  status: string;
  planId: string;
  created: number;
  cancelAt: number | null;
  customer: string;
}> = {}) {
  const tier = TIER_BY_PRICE[priceId] ?? "100gb";
  return {
    id,
    created,
    customer,
    status,
    cancel_at_period_end: false,
    cancel_at: cancelAt,
    metadata: { ...OWNER, planId, billingOfferId: `offer_${tier}`, tier: tier },
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: priceId,
            product: `prod_${tier}`,
            unit_amount: 500,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
          current_period_start: created,
          current_period_end: created + 2_592_000,
        },
      ],
    },
  };
}

function customerMapping() {
  return {
    userId: "user-1",
    stripeId: "cus_1",
    ownership: { stripeId: "cus_1", userId: "user-1", migrationCohort: null, verifiedAt: new Date() },
  };
}

describe("subscription webhook for the storage plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_ENDPOINT_SECRET = "whsec_test";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
    process.env.STRIPE_STORAGE_PRICE_ID_100GB = "price_100";
    process.env.STRIPE_STORAGE_PRICE_ID_200GB = "price_200";
    process.env.STRIPE_STORAGE_PRICE_ID_1TB = "price_1tb";
    process.env.STRIPE_STORAGE_HISTORICAL_OFFERS = "";
    mocks.findCustomerByStripeId.mockResolvedValue(customerMapping());
    mocks.findBillingOfferByStripePriceId.mockImplementation(async ({ stripePriceId }) =>
      TIER_BY_PRICE[stripePriceId] ? offerFor(stripePriceId) : null,
    );
    mocks.getSubscription.mockResolvedValue(null);
    mocks.listCheckoutSessions.mockResolvedValue({ data: [], has_more: false });
    mocks.reconcileSubscriptionObservation.mockResolvedValue({ applied: true });
  });

  function deliver(type: string, object: unknown, created = 1_700_000_100) {
    mocks.constructEvent.mockReturnValue({ id: `evt_${type}`, type, created, data: { object } });
    return POST(request() as never);
  }

  it("records a storage subscription under its plan with the tier from its Price", async () => {
    const sub = subscription();
    mocks.retrieveSubscription.mockResolvedValue(sub);

    const response = await deliver("customer.subscription.updated", sub);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_storage",
        planId: "storage",
        tier: "100gb",
        billingOfferId: "offer_100gb",
        status: "active",
      }),
    );
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledTimes(1);
    // The Pro row of the user is never read for a storage event.
    expect(mocks.getSubscription).not.toHaveBeenCalledWith(
      expect.objectContaining({ planId: "pro" }),
    );
  });

  it("records a Pro subscription under the Pro plan without a tier", async () => {
    const pro = {
      ...subscription({ id: "sub_pro", priceId: "price_pro", planId: "pro" }),
      metadata: { ...OWNER, planId: "pro" },
    };
    pro.items.data[0].price = {
      id: "price_pro",
      product: "prod_pro",
      unit_amount: 2_000,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    };
    mocks.findBillingOfferByStripePriceId.mockResolvedValue({
      id: "offer_pro",
      kind: "pro",
      stripePriceId: "price_pro",
      stripeProductId: "prod_pro",
      unitAmount: 2_000,
      currency: "usd",
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
      checkoutEnabled: true,
    });
    mocks.retrieveSubscription.mockResolvedValue(pro);

    await deliver("customer.subscription.updated", pro);

    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "pro", tier: null, billingOfferId: "offer_pro" }),
    );
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalledWith(
      expect.objectContaining({ planId: "storage" }),
    );
    expect(mocks.getSubscription).not.toHaveBeenCalledWith(
      expect.objectContaining({ planId: "storage" }),
    );
  });

  it("follows a tier change to the new Price", async () => {
    mocks.getSubscription.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_storage",
      planId: "storage",
      tier: "100gb",
      billingOfferId: "offer_100gb",
      status: "active",
    });
    const sub = subscription({ priceId: "price_1tb" });
    mocks.retrieveSubscription.mockResolvedValue(sub);

    await deliver("invoice.paid", {
      id: "in_proration",
      parent: { subscription_details: { subscription: "sub_storage" } },
    });

    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "1tb", billingOfferId: "offer_1tb" }),
    );
    expect(mocks.deleteSubscriptionCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.listCheckoutSessions).toHaveBeenCalledWith(
      expect.objectContaining({ subscription: "sub_storage" }),
    );
  });

  it("marks an unrecognized Price on the stored subscription as invalid", async () => {
    mocks.getSubscription.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_storage",
      planId: "storage",
      tier: "100gb",
      billingOfferId: "offer_100gb",
      status: "active",
    });
    const sub = subscription({ priceId: "price_unknown" });
    mocks.retrieveSubscription.mockResolvedValue(sub);

    await deliver("customer.subscription.updated", sub);

    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "invalid_price",
        tier: "100gb",
        billingOfferId: "offer_100gb",
        replaceExistingSubscription: false,
      }),
    );
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
  });

  it("learns a rotated Price only from the historical allow-list", async () => {
    process.env.STRIPE_STORAGE_HISTORICAL_OFFERS = "price_old:prod_200gb:200gb";
    mocks.findBillingOfferByStripePriceId.mockResolvedValue(null);
    mocks.retrievePrice.mockResolvedValue({
      id: "price_old",
      active: false,
      type: "recurring",
      product: "prod_200gb",
      unit_amount: 400,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.registerHistoricalBillingOffer.mockImplementation(async ({ terms }) => ({
      ...terms,
      id: "offer_historical",
      checkoutEnabled: false,
    }));
    const sub = subscription({ priceId: "price_old" });
    sub.items.data[0].price = {
      id: "price_old",
      product: "prod_200gb",
      unit_amount: 400,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    };
    sub.metadata = { ...OWNER, planId: "storage" };
    mocks.retrieveSubscription.mockResolvedValue(sub);

    await deliver("customer.subscription.updated", sub);

    expect(mocks.registerHistoricalBillingOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: expect.objectContaining({ kind: "storage", tier: "200gb" }),
        ownershipVerified: true,
      }),
    );
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "200gb", billingOfferId: "offer_historical" }),
    );
  });

  it("cancels the stored row on deletion and ignores another subscription", async () => {
    mocks.getSubscription.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_storage",
      planId: "storage",
      tier: "100gb",
      billingOfferId: "offer_100gb",
      status: "active",
    });

    await deliver("customer.subscription.deleted", subscription({ id: "sub_elsewhere" }));
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();

    await deliver("customer.subscription.deleted", subscription());
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "storage", status: "canceled", replaceExistingSubscription: false }),
    );
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledTimes(1);
  });

  it("ignores a storage subscription that does not belong to the mapped user", async () => {
    const sub = subscription({ customer: "cus_1" });
    sub.metadata = { ...OWNER, beutlUserId: "someone-else", planId: "storage" };
    mocks.retrieveSubscription.mockResolvedValue(sub);

    const response = await deliver("customer.subscription.updated", sub);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed historical offer list", async () => {
    process.env.STRIPE_STORAGE_HISTORICAL_OFFERS = "price_old:prod_x:5tb";
    mocks.findBillingOfferByStripePriceId.mockResolvedValue(null);
    const sub = subscription({ priceId: "price_old" });
    mocks.retrieveSubscription.mockResolvedValue(sub);

    const response = await deliver("customer.subscription.updated", sub);

    expect(response.status).toBe(500);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });
});
