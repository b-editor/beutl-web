import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindSubscriptionCheckoutSession: vi.fn(),
  deleteBoundSubscriptionCheckoutAttempt: vi.fn(),
  findSubscriptionCheckoutAttemptBySessionId: vi.fn(),
  getOrCreateSubscriptionCheckoutAttempt: vi.fn(),
  getSubscription: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  setSubscriptionCheckoutAttemptParams: vi.fn(),
  checkoutCreate: vi.fn(),
  checkoutExpire: vi.fn(),
  checkoutList: vi.fn(),
  checkoutRetrieve: vi.fn(),
  pricesRetrieve: vi.fn(),
  portalCreate: vi.fn(),
  portalConfigurationRetrieve: vi.fn(),
  invoicePaymentList: vi.fn(),
  subscriptionCancel: vi.fn(),
  subscriptionList: vi.fn(),
  subscriptionRetrieve: vi.fn(),
  subscriptionUpdate: vi.fn(),
  activateBillingOffer: vi.fn(),
  registerHistoricalBillingOffer: vi.fn(),
  findBillingOfferById: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findStripeCustomerOwnershipByStripeId: vi.fn(),
  sumFileSizeByUserId: vi.fn(),
  sumStorageUploadSizeByUserId: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  startRetryableTransaction: vi.fn(),
  createOrRetrieveOwnedCustomerId: vi.fn(),
  throwIfUnauth: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ throwIfUnauth: mocks.throwIfUnauth }));
vi.mock("@/lib/customer", () => ({
  createOrRetrieveOwnedCustomerId: mocks.createOrRetrieveOwnedCustomerId,
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.checkoutCreate,
        expire: mocks.checkoutExpire,
        list: mocks.checkoutList,
        retrieve: mocks.checkoutRetrieve,
      },
    },
    billingPortal: {
      configurations: { retrieve: mocks.portalConfigurationRetrieve },
      sessions: { create: mocks.portalCreate },
    },
    invoicePayments: { list: mocks.invoicePaymentList },
    subscriptions: {
      cancel: mocks.subscriptionCancel,
      list: mocks.subscriptionList,
      retrieve: mocks.subscriptionRetrieve,
      update: mocks.subscriptionUpdate,
    },
    prices: { retrieve: mocks.pricesRetrieve },
  }),
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT: "pre-owner-metadata-2026-08-09",
  activateBillingOffer: mocks.activateBillingOffer,
  registerHistoricalBillingOffer: mocks.registerHistoricalBillingOffer,
  findBillingOfferById: mocks.findBillingOfferById,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  getOrCreateSubscriptionCheckoutAttempt: mocks.getOrCreateSubscriptionCheckoutAttempt,
  setSubscriptionCheckoutAttemptParams: mocks.setSubscriptionCheckoutAttemptParams,
  bindSubscriptionCheckoutSession: mocks.bindSubscriptionCheckoutSession,
  deleteBoundSubscriptionCheckoutAttempt: mocks.deleteBoundSubscriptionCheckoutAttempt,
  findSubscriptionCheckoutAttemptBySessionId: mocks.findSubscriptionCheckoutAttemptBySessionId,
  findCustomerByUserId: mocks.findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId: mocks.findStripeCustomerOwnershipByStripeId,
  getSubscription: mocks.getSubscription,
  reconcileSubscriptionObservation: mocks.reconcileSubscriptionObservation,
  sumFileSizeByUserId: mocks.sumFileSizeByUserId,
  sumStorageUploadSizeByUserId: mocks.sumStorageUploadSizeByUserId,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));

import {
  changeStorageTier,
  createStorageCancelPortalLink,
  createStorageCheckout,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/storage-actions";

const OWNER = { beutlApplication: "beutl-web", beutlUserId: "user-1" };
const GIB = 1024 * 1024 * 1024;
const PRICE_BY_TIER: Record<string, string> = {
  "100gb": "price_100",
  "200gb": "price_200",
  "1tb": "price_1tb",
};
const TIER_BY_PRICE = Object.fromEntries(
  Object.entries(PRICE_BY_TIER).map(([tier, price]) => [price, tier]),
);

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

function stripePrice(priceId: string) {
  return {
    id: priceId,
    active: true,
    type: "recurring",
    unit_amount: 500,
    currency: "usd",
    product: `prod_${TIER_BY_PRICE[priceId]}`,
    recurring: { interval: "month", interval_count: 1 },
  };
}

function stripeSubscription(priceId: string, overrides: Record<string, unknown> = {}) {
  const tier = TIER_BY_PRICE[priceId];
  return {
    id: "sub_storage",
    status: "active",
    customer: "cus_1",
    created: 1_700_000_000,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { ...OWNER, planId: "storage", billingOfferId: `offer_${tier}`, tier: tier },
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: stripePrice(priceId),
        },
      ],
    },
    ...overrides,
  };
}

function formWith(tier: string): FormData {
  const form = new FormData();
  form.set("tier", tier);
  return form;
}

describe("storage plan checkout actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_ORIGIN = "https://beutl.example";
    process.env.STRIPE_STORAGE_PRICE_ID_100GB = "price_100";
    process.env.STRIPE_STORAGE_PRICE_ID_200GB = "price_200";
    process.env.STRIPE_STORAGE_PRICE_ID_1TB = "price_1tb";
    process.env.STRIPE_STORAGE_HISTORICAL_OFFERS = "";
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_safe";
    mocks.throwIfUnauth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    mocks.createOrRetrieveOwnedCustomerId.mockResolvedValue("cus_1");
    mocks.pricesRetrieve.mockImplementation(async (priceId: string) => stripePrice(priceId));
    mocks.activateBillingOffer.mockImplementation(async ({ terms }) => ({
      ...terms,
      id: `offer_${terms.tier}`,
      checkoutEnabled: true,
    }));
    mocks.findBillingOfferById.mockImplementation(async ({ id }) =>
      offerFor(PRICE_BY_TIER[id.replace("offer_", "")]),
    );
    mocks.findBillingOfferByStripePriceId.mockImplementation(async ({ stripePriceId }) =>
      TIER_BY_PRICE[stripePriceId] ? offerFor(stripePriceId) : null,
    );
    mocks.subscriptionList.mockResolvedValue({ data: [], has_more: false });
    mocks.invoicePaymentList.mockResolvedValue({ data: [], has_more: false });
    mocks.getOrCreateSubscriptionCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-1",
      billingOfferId: "offer_100gb",
      tier: "100gb",
      stripeCheckoutSessionId: null,
      paramsJson: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mocks.setSubscriptionCheckoutAttemptParams.mockResolvedValue({ count: 1 });
    mocks.bindSubscriptionCheckoutSession.mockResolvedValue("bound");
    mocks.deleteBoundSubscriptionCheckoutAttempt.mockResolvedValue(true);
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_storage",
      mode: "subscription",
      status: "open",
      customer: "cus_1",
      allow_promotion_codes: true,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
      url: "https://checkout.stripe.com/storage",
    });
    mocks.checkoutExpire.mockResolvedValue({ id: "cs_old", status: "expired" });
    mocks.portalConfigurationRetrieve.mockResolvedValue({
      id: "bpc_safe",
      active: true,
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: false },
      },
    });
    mocks.portalCreate.mockResolvedValue({ url: "https://billing.stripe.com/portal" });
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_1",
      ownership: { stripeId: "cus_1", userId: "user-1", migrationCohort: null, verifiedAt: new Date() },
    });
    mocks.reconcileSubscriptionObservation.mockResolvedValue({ applied: true, subscription: null });
    mocks.sumFileSizeByUserId.mockResolvedValue(BigInt(0));
    mocks.sumStorageUploadSizeByUserId.mockResolvedValue(BigInt(0));
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => await callback({}),
    );
  });

  it("creates a storage Checkout with the plan and tier in both metadata sets", async () => {
    await expect(createStorageCheckout(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");

    const expectedMetadata = { ...OWNER, planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" };
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_1",
        line_items: [{ price: "price_100", quantity: 1 }],
        metadata: expectedMetadata,
        subscription_data: { metadata: expectedMetadata },
        success_url:
          "https://beutl.example/dashboard/account/billing?checkout=storage-success&session_id={CHECKOUT_SESSION_ID}",
      }),
      { idempotencyKey: "storage-checkout:attempt-1" },
    );
    expect(mocks.getOrCreateSubscriptionCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "100gb", billingOfferId: "offer_100gb" }),
    );
    expect(mocks.bindSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutKey: "attempt-1", stripeCheckoutSessionId: "cs_storage" }),
    );
  });

  it("rejects an unknown tier before touching Stripe", async () => {
    await expect(createStorageCheckout(formWith("5tb"))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("is blocked by any live storage subscription but not by AI Pro", async () => {
    mocks.subscriptionList.mockResolvedValue({
      data: [stripeSubscription("price_1tb", { id: "sub_other_tier" })],
      has_more: false,
    });
    await expect(createStorageCheckout(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();

    mocks.subscriptionList.mockResolvedValue({
      data: [
        {
          id: "sub_pro",
          status: "active",
          items: {
            data: [{ quantity: 1, price: { id: "price_pro", recurring: { interval: "month", interval_count: 1 } } }],
          },
        },
      ],
      has_more: false,
    });
    await expect(createStorageCheckout(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("expires a bound Session for another tier instead of reusing it", async () => {
    mocks.getOrCreateSubscriptionCheckoutAttempt
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-old",
        billingOfferId: "offer_100gb",
        tier: "100gb",
        stripeCheckoutSessionId: "cs_old",
        paramsJson: JSON.stringify({ allow_promotion_codes: true }),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-new",
        billingOfferId: "offer_200gb",
        tier: "200gb",
        stripeCheckoutSessionId: null,
        paramsJson: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_old",
      mode: "subscription",
      status: "open",
      customer: "cus_1",
      url: "https://checkout.stripe.com/old",
      metadata: { ...OWNER, planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
      line_items: { data: [{ quantity: 1, price: { id: "price_100" } }] },
    });

    await expect(createStorageCheckout(formWith("200gb"))).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutExpire).toHaveBeenCalledWith("cs_old");
    expect(mocks.deleteBoundSubscriptionCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutKey: "attempt-old", stripeCheckoutSessionId: "cs_old" }),
    );
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: "price_200", quantity: 1 }] }),
      { idempotencyKey: "storage-checkout:attempt-new" },
    );
  });

  it("reuses an open bound Session for the same tier", async () => {
    mocks.getOrCreateSubscriptionCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-old",
      billingOfferId: "offer_100gb",
      tier: "100gb",
      stripeCheckoutSessionId: "cs_old",
      paramsJson: JSON.stringify({ allow_promotion_codes: true }),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_old",
      mode: "subscription",
      status: "open",
      customer: "cus_1",
      url: "https://checkout.stripe.com/old",
      metadata: { ...OWNER, planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
      line_items: { data: [{ quantity: 1, price: { id: "price_100" } }] },
    });

    await expect(createStorageCheckout(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutExpire).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  describe("changing the tier", () => {
    beforeEach(() => {
      mocks.getSubscription.mockResolvedValue({
        userId: "user-1",
        stripeSubscriptionId: "sub_storage",
        status: "active",
        planId: "storage",
        tier: "100gb",
        billingOfferId: "offer_100gb",
        stripeEventCreatedAt: new Date(80_000),
        currentPeriodStart: new Date(100_000),
        currentPeriodEnd: new Date(200_000),
        cancelAt: null,
        cancelAtPeriodEnd: false,
        entitlementHeld: false,
      });
      mocks.subscriptionRetrieve.mockResolvedValue(stripeSubscription("price_100"));
      mocks.subscriptionUpdate.mockResolvedValue(stripeSubscription("price_1tb"));
    });

    it("switches the item, invoices the difference now, and records the new tier", async () => {
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");

      expect(mocks.subscriptionUpdate).toHaveBeenCalledWith(
        "sub_storage",
        expect.objectContaining({
          items: [{ id: "si_1", price: "price_1tb", quantity: 1 }],
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
          metadata: { ...OWNER, planId: "storage", billingOfferId: "offer_1tb", tier: "1tb" },
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^storage-tier-change:sub_storage:price_100:price_1tb:/),
        }),
      );
      expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeSubscriptionId: "sub_storage",
          tier: "1tb",
          billingOfferId: "offer_1tb",
          stripeEventCreatedAt: new Date(80_000),
          replaceExistingSubscription: false,
        }),
      );
    });

    it("uses a fresh idempotency key for every change", async () => {
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      const keys = mocks.subscriptionUpdate.mock.calls.map((call) => call[2].idempotencyKey);
      expect(new Set(keys).size).toBe(2);
    });

    it("does nothing when the tier is unchanged", async () => {
      await expect(changeStorageTier(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
      expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    });

    it("refuses a downgrade below the current usage", async () => {
      mocks.getSubscription.mockResolvedValue({
        userId: "user-1",
        stripeSubscriptionId: "sub_storage",
        status: "active",
        planId: "storage",
        tier: "1tb",
        billingOfferId: "offer_1tb",
        stripeEventCreatedAt: new Date(80_000),
        currentPeriodStart: new Date(100_000),
        currentPeriodEnd: new Date(200_000),
        cancelAt: null,
        cancelAtPeriodEnd: false,
        entitlementHeld: false,
      });
      mocks.subscriptionRetrieve.mockResolvedValue(stripeSubscription("price_1tb"));
      mocks.sumFileSizeByUserId.mockResolvedValue(BigInt(150 * GIB));

      await expect(changeStorageTier(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
    });

    it("counts uploads still in flight against the smaller tier", async () => {
      const oneTerabyte = {
        userId: "user-1",
        stripeSubscriptionId: "sub_storage",
        status: "active",
        planId: "storage",
        tier: "1tb",
        billingOfferId: "offer_1tb",
        stripeEventCreatedAt: new Date(80_000),
        currentPeriodStart: new Date(100_000),
        currentPeriodEnd: new Date(200_000),
        cancelAt: null,
        cancelAtPeriodEnd: false,
        entitlementHeld: false,
      };
      mocks.getSubscription.mockResolvedValue(oneTerabyte);
      mocks.subscriptionRetrieve.mockResolvedValue(stripeSubscription("price_1tb"));
      mocks.subscriptionUpdate.mockResolvedValue(stripeSubscription("price_100"));
      // 60 GiB stored and 50 GiB reserved by an upload in progress do not fit
      // in 100 GiB, even though the stored files alone would.
      mocks.sumFileSizeByUserId.mockResolvedValue(BigInt(60 * GIB));
      mocks.sumStorageUploadSizeByUserId.mockResolvedValue(BigInt(50 * GIB));

      await expect(changeStorageTier(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();

      mocks.sumStorageUploadSizeByUserId.mockResolvedValue(BigInt(30 * GIB));
      await expect(changeStorageTier(formWith("100gb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.subscriptionUpdate).toHaveBeenCalledTimes(1);
    });

    it("leaves the local row alone when Stripe declines the proration charge", async () => {
      mocks.subscriptionUpdate.mockRejectedValue(
        Object.assign(new Error("Your card was declined."), { statusCode: 402, code: "card_declined" }),
      );
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    });

    it("refuses a subscription that is not the user's or not active", async () => {
      mocks.subscriptionRetrieve.mockResolvedValue(stripeSubscription("price_100", { status: "past_due" }));
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      mocks.subscriptionRetrieve.mockResolvedValue(stripeSubscription("price_100", { customer: "cus_other" }));
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      mocks.subscriptionRetrieve.mockResolvedValue(
        stripeSubscription("price_100", { metadata: { ...OWNER, planId: "pro" } }),
      );
      await expect(changeStorageTier(formWith("1tb"))).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
    });
  });

  it("opens the portal's cancel flow for the stored storage subscription", async () => {
    mocks.getSubscription.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_storage",
      status: "active",
    });
    await expect(createStorageCancelPortalLink()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.portalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        configuration: "bpc_safe",
        flow_data: expect.objectContaining({
          type: "subscription_cancel",
          subscription_cancel: { subscription: "sub_storage" },
        }),
      }),
    );
  });

  it("does not open the portal without a live storage subscription", async () => {
    mocks.getSubscription.mockResolvedValue(null);
    await expect(createStorageCancelPortalLink()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });
});
