import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  registerHistoricalBillingOffer: vi.fn(),
  activateBillingOffer: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrievePrice: vi.fn(),
}));

vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    subscriptions: { retrieve: mocks.retrieveSubscription },
    prices: { retrieve: mocks.retrievePrice },
  }),
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT: "pre-owner-metadata-2026-08-09",
  activateBillingOffer: mocks.activateBillingOffer,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  findCustomerByUserId: mocks.findCustomerByUserId,
  getSubscription: mocks.getSubscription,
  reconcileSubscriptionObservation: mocks.reconcileSubscriptionObservation,
  registerHistoricalBillingOffer: mocks.registerHistoricalBillingOffer,
}));

import { syncSubscriptionFromStripe } from "../../apps/web/src/lib/stripe/subscription-sync";

const syncStorageSubscriptionFromStripe = (userId: string) =>
  syncSubscriptionFromStripe(userId, "storage");

const OWNER = { beutlApplication: "beutl-web", beutlUserId: "user-1" };

function stored(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    stripeSubscriptionId: "sub_storage",
    status: "active",
    planId: "storage",
    tier: "100gb",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    billingOfferId: "offer_100gb",
    stripeEventCreatedAt: new Date(80_000),
    currentPeriodStart: new Date(100_000),
    currentPeriodEnd: new Date(200_000),
    ...overrides,
  };
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_storage",
    status: "active",
    customer: "cus_1",
    created: 50,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { ...OWNER, planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: 100,
          current_period_end: 200,
          price: {
            id: "price_100",
            product: "prod_100gb",
            unit_amount: 500,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("portal sync for the storage plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_STORAGE_PRICE_ID_100GB = "price_100";
    process.env.STRIPE_STORAGE_PRICE_ID_200GB = "price_200";
    process.env.STRIPE_STORAGE_PRICE_ID_1TB = "price_1tb";
    process.env.STRIPE_STORAGE_HISTORICAL_OFFERS = "";
    mocks.reconcileSubscriptionObservation.mockResolvedValue({ applied: true });
    mocks.findBillingOfferByStripePriceId.mockResolvedValue({
      id: "offer_100gb",
      kind: "storage",
      stripePriceId: "price_100",
      stripeProductId: "prod_100gb",
      unitAmount: 500,
      currency: "usd",
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
      tier: "100gb",
      checkoutEnabled: true,
    });
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_1",
      ownership: { stripeId: "cus_1", userId: "user-1", migrationCohort: null, verifiedAt: new Date() },
    });
    mocks.getSubscription.mockResolvedValue(stored());
  });

  it("does nothing without a stored storage subscription", async () => {
    mocks.getSubscription.mockResolvedValue(null);
    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("records a portal cancellation reusing the stored event watermark", async () => {
    mocks.retrieveSubscription.mockResolvedValue(remote({ cancel_at: 200 }));

    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(true);

    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_storage",
        tier: "100gb",
        cancelAtPeriodEnd: true,
        cancelAt: new Date(200_000),
        stripeEventId: "sync:sub_storage",
        stripeEventCreatedAt: new Date(80_000),
        replaceExistingSubscription: false,
      }),
    );
  });

  it("skips the write when nothing changed", async () => {
    mocks.retrieveSubscription.mockResolvedValue(remote());
    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("cancels the row when Stripe no longer knows the subscription", async () => {
    mocks.retrieveSubscription.mockRejectedValue({ statusCode: 404, code: "resource_missing" });
    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        tier: "100gb",
        stripeEventId: "sync:sub_storage:missing",
        replaceExistingSubscription: false,
      }),
    );
  });

  it("ignores a subscription that another user owns", async () => {
    mocks.retrieveSubscription.mockResolvedValue(
      remote({ metadata: { ...OWNER, beutlUserId: "user-2", planId: "storage" } }),
    );
    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("marks an unrecognized Price invalid while keeping the stored tier", async () => {
    mocks.retrieveSubscription.mockResolvedValue(
      remote({
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: 100,
              current_period_end: 200,
              price: { id: "price_unknown", product: "prod_x", unit_amount: 1, currency: "usd", recurring: { interval: "month", interval_count: 1 } },
            },
          ],
        },
      }),
    );
    await expect(syncStorageSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "invalid_price", tier: "100gb", billingOfferId: null }),
    );
  });
});
