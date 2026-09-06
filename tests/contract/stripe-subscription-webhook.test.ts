import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCheckoutSessions: vi.fn(),
  constructEvent: vi.fn(),
  deleteProCheckoutAttempt: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  findCustomerByStripeId: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  retrieveSubscription: vi.fn(),
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
    prices: { retrieve: vi.fn() },
    refunds: { retrieve: vi.fn() },
    subscriptions: { retrieve: mocks.retrieveSubscription },
    webhooks: { constructEvent: mocks.constructEvent },
  }),
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT:
    "pre-owner-metadata-2026-08-09",
  addPurchasedCredits: vi.fn(),
  createUserPackage: vi.fn(),
  createUserPaymentHistory: vi.fn(),
  deleteProCheckoutAttempt: mocks.deleteProCheckoutAttempt,
  existsCreditTransactionByStripePaymentId: vi.fn(),
  existsUserPaymentHistoryByPaymentId: vi.fn(),
  findCustomerByStripeId: mocks.findCustomerByStripeId,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  findPackageIdById: vi.fn(),
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  reconcilePurchasedCreditReversal: vi.fn(),
  reconcileSubscriptionObservation:
    mocks.reconcileSubscriptionObservation,
}));

import { POST } from "../../apps/web/src/app/api/stripe/webhook/route";

function request(): Request {
  return new Request("https://beutl.example/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "signature" },
    body: "{}",
  });
}

function proSubscription({
  id,
  created,
  status = "active",
  cancelAtPeriodEnd = false,
  cancelAt = null,
  metadata = {
    beutlApplication: "beutl-web",
    beutlUserId: "user-1",
    planId: "pro",
  },
}: {
  id: string;
  created: number;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: number | null;
  metadata?: Record<string, string>;
}) {
  return {
    id,
    created,
    customer: "cus_1",
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: cancelAt,
    metadata,
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_pro",
            product: "prod_pro",
            unit_amount: 2_000,
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

describe("canonical Stripe subscription webhook fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_ENDPOINT_SECRET = "whsec_test";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
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
    mocks.constructEvent.mockReturnValue({
      id: "evt_subscription_update",
      created: 1_786_060_900,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_incoming" } },
    });
    mocks.findCustomerByStripeId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_1",
      ownership: {
        stripeId: "cus_1",
        userId: "user-1",
        migrationCohort: null,
        verifiedAt: new Date("2026-08-09T00:00:00.000Z"),
      },
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_current",
    });
    mocks.listCheckoutSessions.mockResolvedValue({
      data: [],
      has_more: false,
    });
  });

  it("records a customer portal cancellation that keeps the plan active", async () => {
    // The portal does not delete the subscription. Stripe keeps reporting
    // `active` and only flags the scheduled cancellation, so that flag is the
    // only signal the account screens can show.
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_incoming",
    });
    mocks.retrieveSubscription.mockResolvedValue(
      proSubscription({
        id: "sub_incoming",
        created: 1_786_060_800,
        cancelAtPeriodEnd: true,
      }),
    );

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_incoming",
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    );
  });

  it("records a portal cancellation reported only through cancel_at", async () => {
    // Current Stripe API versions leave `cancel_at_period_end` false for a
    // portal cancellation and record the scheduled end in `cancel_at`, so the
    // boolean alone would report the plan as unchanged.
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_incoming",
    });
    mocks.retrieveSubscription.mockResolvedValue(
      proSubscription({
        id: "sub_incoming",
        created: 1_786_060_800,
        cancelAtPeriodEnd: false,
        cancelAt: 1_788_652_800,
      }),
    );

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_incoming",
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    );
  });

  it("returns 500 when retrieving the stored canonical subscription fails retryably", async () => {
    mocks.retrieveSubscription
      .mockResolvedValueOnce(
        proSubscription({ id: "sub_incoming", created: 100 }),
      )
      .mockRejectedValueOnce({
        statusCode: 503,
        type: "StripeAPIError",
      });

    const response = await POST(request() as never);

    expect(response.status).toBe(500);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("falls back only when the stored subscription is definitively missing", async () => {
    mocks.retrieveSubscription
      .mockResolvedValueOnce(
        proSubscription({ id: "sub_incoming", created: 200 }),
      )
      .mockRejectedValueOnce({
        code: "resource_missing",
        statusCode: 404,
        type: "StripeInvalidRequestError",
      });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_incoming",
        status: "active",
        stripeEventId: "evt_subscription_update",
        stripeEventCreatedAt: new Date(1_786_060_900_000),
      }),
    );
  });

  it("does not let an older event replace the current active subscription", async () => {
    mocks.retrieveSubscription
      .mockResolvedValueOnce(
        proSubscription({ id: "sub_incoming", created: 100 }),
      )
      .mockResolvedValueOnce(
        proSubscription({ id: "sub_current", created: 200 }),
      );

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_current",
        status: "active",
      }),
    );
  });

  it("rejects metadata-free subscriptions even when the migration cohort names a user", async () => {
    mocks.findCustomerByStripeId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_1",
      ownership: {
        stripeId: "cus_1",
        userId: "user-1",
        migrationCohort: "pre-owner-metadata-2026-08-09",
        verifiedAt: null,
      },
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_incoming",
    });
    mocks.retrieveSubscription.mockResolvedValue(
      proSubscription({ id: "sub_incoming", created: 200, metadata: {} }),
    );

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("ignores deletion of an older subscription while another one is current", async () => {
    mocks.constructEvent.mockReturnValue({
      id: "evt_old_subscription_deleted",
      created: 1_786_060_901,
      type: "customer.subscription.deleted",
      data: {
        object: {
          ...proSubscription({
            id: "sub_incoming",
            created: 100,
            status: "canceled",
          }),
          customer: "cus_1",
        },
      },
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("acknowledges a delayed deletion event after local account removal", async () => {
    mocks.constructEvent.mockReturnValue({
      id: "evt_deleted_customer_subscription",
      created: 1_786_060_902,
      type: "customer.subscription.deleted",
      data: {
        object: {
          ...proSubscription({
            id: "sub_deleted",
            created: 100,
            status: "canceled",
          }),
          customer: "cus_deleted",
        },
      },
    });
    mocks.findCustomerByStripeId.mockResolvedValue(null);

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("acknowledges a delayed update event after local account removal", async () => {
    mocks.constructEvent.mockReturnValue({
      id: "evt_deleted_customer_subscription_update",
      created: 1_786_060_903,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_deleted" } },
    });
    mocks.retrieveSubscription.mockResolvedValue(
      proSubscription({ id: "sub_deleted", created: 100 }),
    );
    mocks.findCustomerByStripeId.mockResolvedValue(null);

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("cleans only the completed Checkout bound to the observed subscription", async () => {
    mocks.constructEvent.mockReturnValue({
      id: "evt_old_subscription_update",
      created: 1_786_060_900,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_old" } },
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_old",
    });
    mocks.retrieveSubscription.mockResolvedValue(
      proSubscription({ id: "sub_old", created: 1_786_060_800 }),
    );
    mocks.listCheckoutSessions.mockResolvedValue({
      data: [
        { id: "cs_old", status: "complete", subscription: "sub_old" },
        { id: "cs_new", status: "open", subscription: "sub_new" },
      ],
      has_more: false,
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.listCheckoutSessions).toHaveBeenCalledWith({
      subscription: "sub_old",
      limit: 100,
    });
    expect(mocks.deleteProCheckoutAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProCheckoutAttempt).toHaveBeenCalledWith({
      userId: "user-1",
      stripeCheckoutSessionId: "cs_old",
    });
  });
});
