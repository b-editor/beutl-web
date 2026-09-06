import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCustomerByUserId: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  registerHistoricalBillingOffer: vi.fn(),
  retrieveCustomer: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrievePrice: vi.fn(),
}));

vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    customers: { retrieve: mocks.retrieveCustomer },
    subscriptions: { retrieve: mocks.retrieveSubscription },
    prices: { retrieve: mocks.retrievePrice },
  }),
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT: "pre-owner-metadata-2026-08-09",
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  findCustomerByUserId: mocks.findCustomerByUserId,
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  reconcileSubscriptionObservation: mocks.reconcileSubscriptionObservation,
  registerHistoricalBillingOffer: mocks.registerHistoricalBillingOffer,
}));

import { syncSubscriptionFromStripe } from "../../apps/web/src/lib/stripe/subscription-sync";

const OWNER_METADATA = {
  beutlApplication: "beutl-web",
  beutlUserId: "user-1",
};

function storedSubscription(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    stripeSubscriptionId: "sub_1",
    status: "active",
    planId: "pro",
    cancelAtPeriodEnd: false,
    billingOfferId: "offer_pro_v1",
    stripeEventCreatedAt: new Date(80_000),
    currentPeriodStart: new Date(100_000),
    currentPeriodEnd: new Date(200_000),
    ...overrides,
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: 50,
    cancel_at_period_end: false,
    metadata: { ...OWNER_METADATA, planId: "pro" },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: 100,
          current_period_end: 200,
          price: {
            id: "price_pro",
            product: "prod_pro",
            unit_amount: 2_000,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("customer portal subscription sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
    mocks.reconcileSubscriptionObservation.mockResolvedValue({ applied: true });
    mocks.findBillingOfferByStripePriceId.mockResolvedValue({
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
    });
    mocks.registerHistoricalBillingOffer.mockImplementation(
      async ({ terms }) => ({
        id: "offer_imported_history",
        ...terms,
        checkoutEnabled: false,
      }),
    );
    mocks.findCustomerByUserId.mockResolvedValue({
      stripeId: "cus_1",
      userId: "user-1",
      ownership: {
        stripeId: "cus_1",
        userId: "user-1",
        migrationCohort: null,
        verifiedAt: new Date(),
      },
    });
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_1",
      metadata: OWNER_METADATA,
    });
  });

  it("stores a cancellation that Stripe has not yet delivered by webhook", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({ cancel_at_period_end: true, canceled_at: 900 }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_1",
        status: "active",
        cancelAtPeriodEnd: true,
        replaceExistingSubscription: false,
      }),
    );
  });

  it("recognizes a portal cancellation reported only through cancel_at", async () => {
    // On current API versions the portal leaves cancel_at_period_end false and
    // records the scheduled end in cancel_at, so reading only the boolean would
    // report the plan as unchanged.
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({
        cancel_at_period_end: false,
        cancel_at: 200,
        canceled_at: 900,
      }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", cancelAtPeriodEnd: true }),
    );
  });

  it("reuses the stored webhook watermark so a later webhook still wins", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      // cancel_at is the future scheduled end; it must not become the watermark.
      stripeSubscription({
        cancel_at_period_end: true,
        cancel_at: 4_000_000_000,
        canceled_at: 900,
      }),
    );

    await syncSubscriptionFromStripe("user-1");

    const observation = mocks.reconcileSubscriptionObservation.mock.calls[0][0];
    expect(observation.stripeEventCreatedAt).toEqual(new Date(80_000));
    expect(observation.stripeEventCreatedAt.getTime()).toBeLessThan(Date.now());
  });

  it("orders a cancellation resumption after the preceding canonical read", async () => {
    mocks.getSubscriptionByUserId
      .mockResolvedValueOnce(storedSubscription())
      .mockResolvedValueOnce(
        storedSubscription({
          cancelAtPeriodEnd: true,
          stripeCanonicalObservedAt: new Date("2026-08-10T00:00:00.000Z"),
        }),
      );
    mocks.retrieveSubscription
      .mockResolvedValueOnce(
        stripeSubscription({ cancel_at_period_end: true, canceled_at: 900 }),
      )
      .mockResolvedValueOnce(
        stripeSubscription({
          cancel_at_period_end: false,
          cancel_at: null,
          canceled_at: null,
        }),
      );

    await syncSubscriptionFromStripe("user-1");
    await syncSubscriptionFromStripe("user-1");

    const resumed = mocks.reconcileSubscriptionObservation.mock.calls[1][0];
    expect(resumed).toMatchObject({
      cancelAtPeriodEnd: false,
      stripeEventCreatedAt: new Date(80_000),
      replaceExistingSubscription: false,
    });
    expect(resumed.stripeCanonicalObservedAt.getTime()).toBeGreaterThanOrEqual(
      mocks.reconcileSubscriptionObservation.mock.calls[0][0]
        .stripeCanonicalObservedAt.getTime(),
    );
  });

  it("writes nothing when Stripe agrees with the stored row", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(stripeSubscription());

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("records the terminal status once the cancellation takes effect", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({ status: "canceled" }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "canceled" }),
    );
  });

  it("keeps a paid historical Price valid after checkout rotates", async () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_v2";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "price_pro_v1:prod_pro";
    mocks.getSubscriptionByUserId.mockResolvedValue(
      storedSubscription({ billingOfferId: "offer_pro_v1" }),
    );
    mocks.findBillingOfferByStripePriceId.mockResolvedValue({
      id: "offer_pro_v1",
      kind: "pro",
      stripePriceId: "price_pro_v1",
      stripeProductId: "prod_pro",
      unitAmount: 2_000,
      currency: "usd",
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
      checkoutEnabled: false,
    });
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: 100,
              current_period_end: 201,
              price: {
                id: "price_pro_v1",
                product: "prod_pro",
                unit_amount: 2_000,
                currency: "usd",
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        billingOfferId: "offer_pro_v1",
      }),
    );
  });

  it("imports an owned archived Price as a disabled historical offer", async () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_v2";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS =
      "price_pro_archived:prod_pro";
    mocks.findBillingOfferByStripePriceId.mockResolvedValue(null);
    mocks.getSubscriptionByUserId.mockResolvedValue(
      storedSubscription({ billingOfferId: null }),
    );
    mocks.retrievePrice.mockResolvedValue({
      id: "price_pro_archived",
      active: false,
      type: "recurring",
      product: "prod_pro",
      unit_amount: 2_000,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({
        metadata: { ...OWNER_METADATA, planId: "pro" },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: 100,
              current_period_end: 201,
              price: {
                id: "price_pro_archived",
                active: false,
                type: "recurring",
                product: "prod_pro",
                unit_amount: 2_000,
                currency: "usd",
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.registerHistoricalBillingOffer).toHaveBeenCalledWith({
      ownershipVerified: true,
      terms: expect.objectContaining({
        stripePriceId: "price_pro_archived",
        kind: "pro",
      }),
    });
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        billingOfferId: "offer_imported_history",
      }),
    );
  });

  it("ignores a subscription that belongs to another customer", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({ customer: "cus_other", cancel_at_period_end: true }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("rejects a metadata-free subscription even when the customer metadata matches", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockResolvedValue(
      stripeSubscription({ metadata: {}, cancel_at_period_end: true }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("marks a subscription Stripe no longer knows about as canceled", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(storedSubscription());
    mocks.retrieveSubscription.mockRejectedValue(
      Object.assign(new Error("No such subscription"), {
        statusCode: 404,
        code: "resource_missing",
      }),
    );

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(true);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_1",
        status: "canceled",
        planId: "pro",
        billingOfferId: "offer_pro_v1",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        replaceExistingSubscription: false,
      }),
    );
  });

  it("does nothing for a user without a stored subscription", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);

    await expect(syncSubscriptionFromStripe("user-1")).resolves.toBe(false);
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
  });
});
