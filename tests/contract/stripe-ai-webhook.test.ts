import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  addPurchasedCredits: vi.fn(),
  constructEvent: vi.fn(),
  createUserPackage: vi.fn(),
  createUserPaymentHistory: vi.fn(),
  deleteProCheckoutAttempt: vi.fn(),
  existsCreditTransactionByStripePaymentId: vi.fn(),
  existsUserPaymentHistoryByPaymentId: vi.fn(),
  findCreditPurchaseByStripePaymentId: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
  findTopUpCheckoutAttempt: vi.fn(),
  findCustomerByStripeId: vi.fn(),
  findPackagePaymentReference: vi.fn(),
  findStripeCustomerOwnershipByStripeId: vi.fn(),
  findPackageIdById: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  reconcilePurchasedCreditReversal: vi.fn(),
  reconcileSubscriptionObservation: vi.fn(),
  reconcileSubscriptionEntitlementHold: vi.fn(),
  registerHistoricalBillingOffer: vi.fn(),
  fulfillTopUpCheckoutAttempt: vi.fn(),
  requireTopUpRefund: vi.fn(),
  recordTopUpRefund: vi.fn(),
  recordPackagePaymentSucceeded: vi.fn(),
  refundPackagePayment: vi.fn(),
  resolvePackagePayment: vi.fn(),
  resolvePackagePaymentOwner: vi.fn(),
  restorePackagePayment: vi.fn(),
  revokePackagePayment: vi.fn(),
  retrieveDispute: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveRefund: vi.fn(),
  retrievePrice: vi.fn(),
  retrieveCharge: vi.fn(),
  listCharges: vi.fn(),
  listCheckoutSessions: vi.fn(),
  listDisputes: vi.fn(),
  listRefunds: vi.fn(),
  listInvoicePayments: vi.fn(),
  observeBillingRefundForPaymentIntent: vi.fn(),
  retrieveInvoice: vi.fn(),
  createRefund: vi.fn(),
}));

vi.mock("@beutl/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@beutl/api")>()),
  observeBillingRefundForPaymentIntent:
    mocks.observeBillingRefundForPaymentIntent,
}));

vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    store: {
      paymentSucceeded: "store.paymentSucceeded",
    },
  },
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: { sessions: { list: mocks.listCheckoutSessions } },
    subscriptions: {
      retrieve: mocks.retrieveSubscription,
    },
    paymentIntents: {
      retrieve: mocks.retrievePaymentIntent,
    },
    refunds: {
      create: mocks.createRefund,
      retrieve: mocks.retrieveRefund,
      list: mocks.listRefunds,
    },
    disputes: {
      list: mocks.listDisputes,
      retrieve: mocks.retrieveDispute,
    },
    prices: {
      retrieve: mocks.retrievePrice,
    },
    charges: {
      list: mocks.listCharges,
      retrieve: mocks.retrieveCharge,
    },
    invoicePayments: { list: mocks.listInvoicePayments },
    invoices: { retrieve: mocks.retrieveInvoice },
    webhooks: {
      constructEvent: mocks.constructEvent,
    },
  }),
}));
vi.mock("@/lib/stripe/package-payment", () => ({
  refundPackagePayment: mocks.refundPackagePayment,
  resolvePackagePayment: mocks.resolvePackagePayment,
  resolvePackagePaymentOwner: mocks.resolvePackagePaymentOwner,
}));
vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT:
    "pre-owner-metadata-2026-08-09",
  addPurchasedCredits: mocks.addPurchasedCredits,
  createUserPackage: mocks.createUserPackage,
  createUserPaymentHistory: mocks.createUserPaymentHistory,
  deleteProCheckoutAttempt: mocks.deleteProCheckoutAttempt,
  existsCreditTransactionByStripePaymentId:
    mocks.existsCreditTransactionByStripePaymentId,
  existsUserPaymentHistoryByPaymentId:
    mocks.existsUserPaymentHistoryByPaymentId,
  findCreditPurchaseByStripePaymentId:
    mocks.findCreditPurchaseByStripePaymentId,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
  findTopUpCheckoutAttempt: mocks.findTopUpCheckoutAttempt,
  findCustomerByStripeId: mocks.findCustomerByStripeId,
  findPackagePaymentReference: mocks.findPackagePaymentReference,
  findStripeCustomerOwnershipByStripeId:
    mocks.findStripeCustomerOwnershipByStripeId,
  findPackageIdById: mocks.findPackageIdById,
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  PACKAGE_PAYMENT_EVENT_RANK: {
    paymentSucceeded: 10,
    refundSucceeded: 20,
    disputeRevoked: 30,
    disputeRestored: 40,
  },
  reconcilePurchasedCreditReversal:
    mocks.reconcilePurchasedCreditReversal,
  reconcileSubscriptionObservation:
    mocks.reconcileSubscriptionObservation,
  reconcileSubscriptionEntitlementHold:
    mocks.reconcileSubscriptionEntitlementHold,
  registerHistoricalBillingOffer: mocks.registerHistoricalBillingOffer,
  fulfillTopUpCheckoutAttempt: mocks.fulfillTopUpCheckoutAttempt,
  requireTopUpRefund: mocks.requireTopUpRefund,
  recordTopUpRefund: mocks.recordTopUpRefund,
  recordPackagePaymentSucceeded: mocks.recordPackagePaymentSucceeded,
  restorePackagePayment: mocks.restorePackagePayment,
  revokePackagePayment: mocks.revokePackagePayment,
}));

import { POST } from "../../apps/web/src/app/api/stripe/webhook/route";

function webhookRequest(): Request {
  return new Request("https://beutl.example/api/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "test-signature",
    },
    body: "{}",
  });
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  created = 1_786_060_900,
) {
  return {
    id: `evt_${type.replaceAll(".", "_")}`,
    created,
    type,
    data: { object },
  };
}

function mockProInvoicePaymentContext() {
  const invoicePayment = {
    id: "inpay_pro_1",
    invoice: "in_pro_1",
    amount_paid: 2_000,
    currency: "usd",
    status: "paid",
    payment: {
      type: "payment_intent",
      payment_intent: "pi_pro_invoice",
    },
  };
  mocks.retrievePaymentIntent.mockResolvedValue({
    id: "pi_pro_invoice",
    customer: "cus_1",
    amount_received: 2_000,
    currency: "usd",
    metadata: {},
  });
  mocks.listInvoicePayments.mockResolvedValue({
    data: [invoicePayment],
    has_more: false,
  });
  mocks.retrieveInvoice.mockResolvedValue({
    id: "in_pro_1",
    amount_paid: 2_000,
    currency: "usd",
    customer: "cus_1",
    status: "paid",
    parent: {
      subscription_details: { subscription: "sub_pro_1" },
    },
    period_start: 1_786_060_800,
    period_end: 1_788_739_200,
  });
  mocks.getSubscriptionByUserId.mockResolvedValue({
    userId: "user-1",
    stripeSubscriptionId: "sub_pro_1",
    billingOfferId: "offer_pro_v1",
  });
  mocks.retrieveSubscription.mockResolvedValue({
    id: "sub_pro_1",
    created: 1_786_060_700,
    customer: "cus_1",
    status: "active",
    metadata: {
      beutlApplication: "beutl-web",
      beutlUserId: "user-1",
      planId: "pro",
      billingOfferId: "offer_pro_v1",
    },
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
          current_period_start: 1_786_060_800,
          current_period_end: 1_788_739_200,
        },
      ],
    },
  });
}

function mockMultiPaymentProInvoice() {
  mockProInvoicePaymentContext();
  const invoicePayments = [
    {
      id: "inpay_pro_1",
      invoice: "in_pro_1",
      amount_paid: 1_000,
      currency: "usd",
      status: "paid",
      payment: { type: "payment_intent", payment_intent: "pi_pro_1" },
    },
    {
      id: "inpay_pro_2",
      invoice: "in_pro_1",
      amount_paid: 1_000,
      currency: "usd",
      status: "paid",
      payment: { type: "payment_intent", payment_intent: "pi_pro_2" },
    },
  ];
  const paymentIntents = new Map([
    [
      "pi_pro_1",
      {
        id: "pi_pro_1",
        customer: "cus_1",
        amount_received: 1_000,
        currency: "usd",
        metadata: {},
      },
    ],
    [
      "pi_pro_2",
      {
        id: "pi_pro_2",
        customer: "cus_1",
        amount_received: 1_000,
        currency: "usd",
        metadata: {},
      },
    ],
  ]);
  const refundsByPaymentIntent = new Map<string, Array<Record<string, unknown>>>([
    ["pi_pro_1", []],
    ["pi_pro_2", []],
  ]);
  mocks.listInvoicePayments.mockImplementation(async (params: any) => {
    const paymentIntentId = params.payment?.payment_intent;
    if (paymentIntentId) {
      return {
        data: invoicePayments.filter(
          (payment) =>
            payment.payment.payment_intent === paymentIntentId,
        ),
        has_more: false,
      };
    }
    if (params.invoice === "in_pro_1") {
      if (!params.starting_after) {
        return { data: [invoicePayments[0]], has_more: true };
      }
      if (params.starting_after === invoicePayments[0].id) {
        return { data: [invoicePayments[1]], has_more: false };
      }
    }
    throw new Error("Unexpected InvoicePayment list request");
  });
  mocks.retrievePaymentIntent.mockImplementation(async (id: string) => {
    const paymentIntent = paymentIntents.get(id);
    if (!paymentIntent) throw new Error(`Unexpected PaymentIntent ${id}`);
    return paymentIntent;
  });
  mocks.listRefunds.mockImplementation(
    async ({ payment_intent }: { payment_intent: string }) => ({
      data: refundsByPaymentIntent.get(payment_intent) ?? [],
      has_more: false,
    }),
  );
  mocks.retrieveRefund.mockImplementation(async (id: string) => {
    const refund = [...refundsByPaymentIntent.values()]
      .flat()
      .find((candidate) => candidate.id === id);
    if (!refund) throw new Error(`Unexpected Refund ${id}`);
    return refund;
  });
  return { paymentIntents, refundsByPaymentIntent };
}

describe("Stripe AI billing webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_ENDPOINT_SECRET = "whsec_test";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
    process.env.STRIPE_CREDIT_PRICE_ID = "price_credits";
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
    mocks.findCreditPurchaseByStripePaymentId.mockResolvedValue(null);
    mocks.findBillingOfferByStripePriceId.mockImplementation(
      async ({ stripePriceId }: { stripePriceId: string }) =>
        stripePriceId === "price_pro"
          ? {
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
            }
          : null,
    );
    mocks.findTopUpCheckoutAttempt.mockResolvedValue({
      id: "topup-attempt-1",
      ownerUserId: "user-1",
      stripeCustomerId: "cus_1",
      billingOfferId: "offer_top_up_v1",
      status: "open",
      billingOffer: {
        id: "offer_top_up_v1",
        kind: "top_up",
        stripePriceId: "price_credits",
        stripeProductId: "prod_top_up",
        unitAmount: 1_000,
        currency: "usd",
        creditAmount: 500,
        recurringInterval: null,
        recurringIntervalCount: null,
        checkoutEnabled: true,
      },
    });
    mocks.registerHistoricalBillingOffer.mockImplementation(
      async ({ terms }: { terms: Record<string, unknown> }) => ({
        id: "offer_historical_pro",
        ...terms,
        checkoutEnabled: false,
      }),
    );
    mocks.fulfillTopUpCheckoutAttempt.mockResolvedValue({
      status: "fulfilled",
      userId: "user-1",
      creditAmount: 500,
    });
    mocks.createRefund.mockResolvedValue({
      id: "re_automatic",
      status: "succeeded",
    });
    mocks.listCharges.mockResolvedValue({ data: [], has_more: false });
    mocks.listCheckoutSessions.mockResolvedValue({
      data: [],
      has_more: false,
    });
    mocks.listDisputes.mockResolvedValue({ data: [], has_more: false });
    mocks.listInvoicePayments.mockResolvedValue({
      data: [],
      has_more: false,
    });
    mocks.listRefunds.mockResolvedValue({ data: [], has_more: false });
    mocks.observeBillingRefundForPaymentIntent.mockResolvedValue(false);
    mocks.findStripeCustomerOwnershipByStripeId.mockResolvedValue({
      stripeId: "cus_1",
      userId: "user-1",
      migrationCohort: null,
      verifiedAt: new Date("2026-08-09T00:00:00.000Z"),
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "unrecognized",
    });
    mocks.resolvePackagePaymentOwner.mockResolvedValue({
      status: "unrecognized",
    });
    mocks.findPackagePaymentReference.mockResolvedValue(null);
    mocks.revokePackagePayment.mockResolvedValue(null);
    mocks.restorePackagePayment.mockResolvedValue(null);
    mocks.existsCreditTransactionByStripePaymentId.mockResolvedValue(false);
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.retrievePrice.mockResolvedValue({
      id: "price_credits",
      unit_amount: 1000,
      currency: "usd",
    });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      amount: 1000,
      amount_received: 1000,
      currency: "usd",
      status: "succeeded",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        creditAmount: "500",
        billingOfferId: "offer_top_up_v1",
        topUpAttemptId: "topup-attempt-1",
      },
    });
  });

  it("advances the paid billing period without granting credits", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("invoice.paid", {
        id: "in_1",
        customer: "cus_1",
        parent: {
          subscription_details: {
            subscription: "sub_1",
          },
        },
      }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      created: 1_786_060_700,
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
      },
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
            current_period_start: 1_786_060_800,
            current_period_end: 1_788_739_200,
          },
        ],
      },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith({
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_v1",
      currentPeriodStart: new Date(1_786_060_800_000),
      currentPeriodEnd: new Date(1_788_739_200_000),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeSubscriptionCreatedAt: new Date(1_786_060_700_000),
      stripeEventId: "evt_invoice_paid",
      stripeEventCreatedAt: new Date(1_786_060_900_000),
      stripeCanonicalObservedAt: expect.any(Date),
      replaceExistingSubscription: true,
    });
    expect(mocks.addPurchasedCredits).not.toHaveBeenCalled();
  });

  it("acknowledges a delayed paid invoice after local account removal", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("invoice.paid", {
        id: "in_deleted_customer",
        customer: "cus_deleted",
        parent: {
          subscription_details: {
            subscription: "sub_deleted",
          },
        },
      }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_deleted",
      customer: "cus_deleted",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "deleted-user",
        planId: "pro",
      },
      items: { data: [] },
    });
    mocks.findCustomerByStripeId.mockResolvedValue(null);

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("grants a top-up only once from PaymentIntent metadata", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", {
        id: "pi_1",
        customer: "cus_1",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
        status: "succeeded",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          creditAmount: "500",
          billingOfferId: "offer_top_up_v1",
          topUpAttemptId: "topup-attempt-1",
        },
      }),
    );

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.fulfillTopUpCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "topup-attempt-1",
        stripePaymentIntentId: "pi_1",
      }),
    );
  });

  it("reconciles a partial refund from the canonical Stripe objects", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.updated", {
        id: "re_partial",
        status: "failed",
        amount: 100,
      }),
    );
    const canonicalRefund = {
      id: "re_partial",
      payment_intent: "pi_1",
      amount: 400,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({
      data: [canonicalRefund],
      has_more: false,
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.retrieveRefund).toHaveBeenCalledWith("re_partial");
    expect(mocks.retrievePaymentIntent).toHaveBeenCalledWith("pi_1");
    expect(mocks.reconcilePurchasedCreditReversal).toHaveBeenCalledWith({
      stripePaymentId: "pi_1",
      stripePayment: { amount: 1000, currency: "usd" },
      reversalKind: "refund",
      reversalId: "re_partial",
      reversalAmount: 400,
      reversalCurrency: "usd",
      status: "succeeded",
      active: true,
      stripeEventId: "evt_refund_updated",
      stripeEventCreatedAt: new Date(1_786_060_900_000),
    });
    expect(mocks.recordTopUpRefund).toHaveBeenCalledWith({
      attemptId: "topup-attempt-1",
      stripePaymentIntentId: "pi_1",
      refundId: "re_partial",
      refundStatus: "succeeded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 400,
      refundPendingAmount: 0,
      refundCurrency: "usd",
    });
  });

  it.each([
    ["refund.failed", "failed"],
    ["refund.updated", "canceled"],
  ])("restores credits for a canonical %s refund", async (eventType, status) => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent(eventType, { id: "re_restored" }),
    );
    const canonicalRefund = {
      id: "re_restored",
      payment_intent: "pi_1",
      amount: 1000,
      currency: "usd",
      status,
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({
      data: [canonicalRefund],
      has_more: false,
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcilePurchasedCreditReversal).toHaveBeenCalledWith(
      expect.objectContaining({
        reversalKind: "refund",
        reversalId: "re_restored",
        status,
        active: false,
        stripeEventCreatedAt: new Date(1_786_060_900_000),
      }),
    );
  });

  it.each([
    ["charge.dispute.created", "needs_response", true],
    ["charge.dispute.funds_withdrawn", "under_review", true],
    ["charge.dispute.closed", "lost", true],
    ["charge.dispute.funds_reinstated", "won", false],
  ])(
    "reconciles %s from the canonical dispute status",
    async (eventType, status, active) => {
      mocks.constructEvent.mockReturnValue(
        stripeEvent(eventType, { id: "dp_1", status: "stale" }),
      );
      mocks.retrieveDispute.mockResolvedValue({
        id: "dp_1",
        payment_intent: "pi_1",
        amount: 1000,
        currency: "usd",
        status,
      });

      const response = await POST(webhookRequest() as never);

      expect(response.status).toBe(200);
      expect(mocks.retrieveDispute).toHaveBeenCalledWith("dp_1");
      expect(mocks.reconcilePurchasedCreditReversal).toHaveBeenCalledWith({
        stripePaymentId: "pi_1",
        stripePayment: { amount: 1000, currency: "usd" },
        reversalKind: "dispute",
        reversalId: "dp_1",
        reversalAmount: 1000,
        reversalCurrency: "usd",
        status,
        active,
        stripeEventId: `evt_${eventType.replaceAll(".", "_")}`,
        stripeEventCreatedAt: new Date(1_786_060_900_000),
      });
    },
  );

  it("reconciles a persisted top-up refund after customer and offer rotation", async () => {
    process.env.STRIPE_CREDIT_PRICE_ID = "price_credits_v2";
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.updated", { id: "re_old_customer" }),
    );
    const canonicalRefund = {
      id: "re_old_customer",
      payment_intent: "pi_1",
      amount: 1_000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({ data: [canonicalRefund], has_more: false });
    mocks.findCreditPurchaseByStripePaymentId.mockResolvedValue({
      userId: "user-1",
      creditAmount: 500,
      billingOfferId: "offer_top_up_v1",
      topUpCheckoutAttemptId: "topup-attempt-old",
      stripePaymentAmount: 1_000,
      stripeCurrency: "usd",
    });
    mocks.findTopUpCheckoutAttempt.mockResolvedValue(null);
    mocks.findCustomerByStripeId.mockResolvedValue(null);

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcilePurchasedCreditReversal).toHaveBeenCalledWith(
      expect.objectContaining({
        stripePaymentId: "pi_1",
        reversalKind: "refund",
        reversalId: "re_old_customer",
        active: true,
      }),
    );
  });

  it("ignores a refund that is not linked to the configured top-up", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_package" }),
    );
    const canonicalRefund = {
      id: "re_package",
      payment_intent: "pi_package",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({ data: [canonicalRefund], has_more: false });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_package",
      amount_received: 1000,
      currency: "usd",
      metadata: { packageId: "package-1" },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcilePurchasedCreditReversal).not.toHaveBeenCalled();
  });

  it("marks the stored subscription canceled when a refund follows a Stripe cancellation", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_sub" }),
    );
    const canonicalRefund = {
      id: "re_sub",
      payment_intent: "pi_sub",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({ data: [canonicalRefund], has_more: false });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_sub",
      customer: "cus_1",
      amount_received: 1000,
      currency: "usd",
      metadata: {},
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_refunded",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_refunded",
      customer: "cus_1",
      status: "canceled",
      created: 1_700_000_000,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
      },
      items: { data: [] },
    });
    mocks.listCheckoutSessions.mockResolvedValue({
      data: [{
        id: "cs_refunded",
        status: "complete",
        subscription: "sub_refunded",
      }],
      has_more: false,
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_refunded",
        status: "canceled",
        replaceExistingSubscription: false,
      }),
    );
    expect(mocks.deleteProCheckoutAttempt).toHaveBeenCalledWith({
      userId: "user-1",
      stripeCheckoutSessionId: "cs_refunded",
    });
  });

  it("keeps a still-active subscription untouched when an unrelated refund arrives", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_other" }),
    );
    const canonicalRefund = {
      id: "re_other",
      payment_intent: "pi_other",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({ data: [canonicalRefund], has_more: false });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_other",
      customer: "cus_1",
      amount_received: 1000,
      currency: "usd",
      metadata: {},
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_active",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_active",
      customer: "cus_1",
      status: "active",
      created: 1_700_000_000,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
      },
      items: { data: [] },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.registerHistoricalBillingOffer).not.toHaveBeenCalled();
  });

  it("registers an owned inactive historical Pro price after environment rotation", async () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_v2";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS =
      "price_pro_v1:prod_pro_v1";
    mocks.constructEvent.mockReturnValue(
      stripeEvent("customer.subscription.updated", { id: "sub_historical" }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_historical",
      created: 1_786_060_700,
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
      },
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_pro_v1",
              product: "prod_pro_v1",
              unit_amount: 2_000,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
            current_period_start: 1_786_060_800,
            current_period_end: 1_788_739_200,
          },
        ],
      },
    });
    mocks.retrievePrice.mockResolvedValue({
      id: "price_pro_v1",
      active: false,
      product: "prod_pro_v1",
      unit_amount: 2_000,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.registerHistoricalBillingOffer).toHaveBeenCalledWith({
      ownershipVerified: true,
      terms: {
        kind: "pro",
        stripePriceId: "price_pro_v1",
        stripeProductId: "prod_pro_v1",
        unitAmount: 2_000,
        currency: "usd",
        creditAmount: null,
        recurringInterval: "month",
        recurringIntervalCount: 1,
      },
    });
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_historical",
        billingOfferId: "offer_historical_pro",
        status: "active",
      }),
    );
  });

  it("ignores subscriptions that do not use the configured Pro price", async () => {
    mocks.findBillingOfferByStripePriceId.mockResolvedValue({
      id: "offer_portal_switched",
      kind: "pro",
      stripePriceId: "price_other",
      stripeProductId: "prod_other",
      unitAmount: 100,
      currency: "usd",
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
      checkoutEnabled: false,
    });
    mocks.constructEvent.mockReturnValue(
      stripeEvent("customer.subscription.created", {
        id: "sub_other",
        customer: "cus_1",
        status: "active",
        metadata: {},
        items: { data: [] },
      }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_other",
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
      },
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_other",
              product: "prod_other",
              unit_amount: 100,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.registerHistoricalBillingOffer).not.toHaveBeenCalled();
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
  });

  it("retrieves the latest subscription when events arrive out of order", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { planId: "pro" },
        items: {
          data: [
            {
              current_period_start: 1_783_382_400,
              current_period_end: 1_786_060_800,
            },
          ],
        },
      }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      created: 1_780_876_800,
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
      },
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
            current_period_start: 1_786_060_800,
            current_period_end: 1_788_739_200,
          },
        ],
      },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPeriodStart: new Date(1_786_060_800_000),
        currentPeriodEnd: new Date(1_788_739_200_000),
      }),
    );
  });

  it("does not grant top-up credits when the paid amount mismatches the configured price", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", {
        id: "pi_wrong_amount",
        customer: "cus_1",
        amount_received: 500,
        currency: "usd",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          creditAmount: "500",
          creditPriceId: "price_credits",
        },
      }),
    );

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.addPurchasedCredits).not.toHaveBeenCalled();
  });

  it("does not grant top-up credits when PaymentIntent ownership mismatches", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", {
        id: "pi_other_owner",
        customer: "cus_1",
        amount_received: 1000,
        currency: "usd",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "another-user",
          creditAmount: "500",
          creditPriceId: "price_credits",
        },
      }),
    );

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.addPurchasedCredits).not.toHaveBeenCalled();
  });

  it("does not fulfill a package PaymentIntent without matching ownership metadata", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", {
        id: "pi_unowned_package",
        customer: "cus_1",
        amount_received: 1000,
        currency: "usd",
        metadata: {
          packageId: "package-1",
          beutlApplication: "beutl-web",
          beutlUserId: "another-user",
        },
      }),
    );

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.findPackageIdById).not.toHaveBeenCalled();
    expect(mocks.createUserPackage).not.toHaveBeenCalled();
    expect(mocks.createUserPaymentHistory).not.toHaveBeenCalled();
  });

  it("does not register a historical Pro price without matching ownership metadata", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("customer.subscription.updated", { id: "sub_unowned" }),
    );
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_unowned",
      created: 1_786_060_700,
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "another-user",
        planId: "pro",
      },
      items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_historical_unowned",
              product: "prod_historical_unowned",
              unit_amount: 2_000,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
            current_period_start: 1_786_060_800,
            current_period_end: 1_788_739_200,
          },
        ],
      },
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
    expect(mocks.registerHistoricalBillingOffer).not.toHaveBeenCalled();
  });

  it("does not let a delayed event from an older subscription replace the current one", async () => {
    mocks.constructEvent.mockReturnValue(
      stripeEvent("customer.subscription.updated", {
        id: "sub_old",
      }),
    );
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_current",
    });
    mocks.retrieveSubscription.mockImplementation(async (id: string) => {
      if (id === "sub_current") {
        return {
          id,
          customer: "cus_1",
          created: 1_786_060_800,
          status: "active",
          metadata: {
            beutlApplication: "beutl-web",
            beutlUserId: "user-1",
            planId: "pro",
          },
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
                current_period_start: 1_786_060_800,
                current_period_end: 1_788_739_200,
              },
            ],
          },
        };
      }
      return {
        id,
        customer: "cus_1",
        created: 1_780_876_800,
        status: "canceled",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          planId: "pro",
        },
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
              current_period_start: 1_780_876_800,
              current_period_end: 1_783_382_400,
            },
          ],
        },
      };
    });

    const response = await POST(webhookRequest() as never);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSubscriptionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_current",
        status: "active",
      }),
    );
  });

  it("holds and idempotently restores Pro access for a disputed invoice payment", async () => {
    const proPaymentIntent = {
      id: "pi_pro_invoice",
      customer: "cus_1",
      amount_received: 2_000,
      currency: "usd",
      metadata: {},
    };
    mocks.retrievePaymentIntent.mockResolvedValue(proPaymentIntent);
    mocks.listInvoicePayments.mockResolvedValue({
      data: [{
        id: "inpay_pro_1",
        invoice: "in_pro_1",
        amount_paid: 2_000,
        currency: "usd",
        status: "paid",
        payment: {
          type: "payment_intent",
          payment_intent: "pi_pro_invoice",
        },
      }],
      has_more: false,
    });
    mocks.retrieveInvoice.mockResolvedValue({
      id: "in_pro_1",
      amount_paid: 2_000,
      currency: "usd",
      customer: "cus_1",
      status: "paid",
      parent: {
        subscription_details: { subscription: "sub_pro_1" },
      },
      period_start: 1_786_060_800,
      period_end: 1_788_739_200,
    });
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_pro_1",
      billingOfferId: "offer_pro_v1",
    });
    mocks.retrieveSubscription.mockResolvedValue({
      id: "sub_pro_1",
      created: 1_786_060_700,
      customer: "cus_1",
      status: "active",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro_v1",
      },
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
            current_period_start: 1_786_060_800,
            current_period_end: 1_788_739_200,
          },
        ],
      },
    });
    mocks.listCharges.mockResolvedValue({
      data: [{
        id: "ch_pro_1",
        customer: "cus_1",
        currency: "usd",
        payment_intent: "pi_pro_invoice",
      }],
      has_more: false,
    });

    mocks.constructEvent.mockReturnValue(
      stripeEvent("charge.dispute.created", { id: "dp_pro_1" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_pro_1",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "needs_response",
    });
    mocks.listDisputes.mockResolvedValue({
      data: [{
        id: "dp_pro_1",
        charge: "ch_pro_1",
        payment_intent: "pi_pro_invoice",
        amount: 2_000,
        currency: "usd",
        status: "needs_response",
      }],
      has_more: false,
    });
    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_pro_1",
        stripePaymentIntentId: "pi_pro_invoice",
        stripeReversalId: "dp_pro_1",
        active: true,
      }),
    );

    mocks.constructEvent.mockReturnValue(
      stripeEvent("charge.dispute.closed", { id: "dp_pro_1" }, 1_786_060_901),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_pro_1",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "won",
    });
    mocks.listDisputes.mockResolvedValue({
      data: [{
        id: "dp_pro_1",
        charge: "ch_pro_1",
        payment_intent: "pi_pro_invoice",
        amount: 2_000,
        currency: "usd",
        status: "won",
      }],
      has_more: false,
    });
    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeReversalId: "dp_pro_1",
        status: "won",
        active: false,
      }),
    );
  });

  it("records a Pro reversal that arrives before its subscription event", async () => {
    mockProInvoicePaymentContext();
    mocks.getSubscriptionByUserId.mockResolvedValue({
      userId: "user-1",
      stripeSubscriptionId: "sub_previous",
      billingOfferId: "offer_pro_v1",
    });
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_before_subscription" }),
    );
    const canonicalRefund = {
      id: "re_before_subscription",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(canonicalRefund);
    mocks.listRefunds.mockResolvedValue({ data: [canonicalRefund], has_more: false });

    expect((await POST(webhookRequest() as never)).status).toBe(200);

    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        stripeSubscriptionId: "sub_pro_1",
        stripeReversalId: "re_before_subscription",
        active: true,
      }),
    );
    expect(mocks.reconcileSubscriptionObservation).not.toHaveBeenCalled();
  });

  it("does not hold an entire Pro billing period for a partial refund", async () => {
    mockProInvoicePaymentContext();
    const partialRefund = {
      id: "re_pro_partial",
      payment_intent: "pi_pro_invoice",
      amount: 400,
      currency: "usd",
      status: "succeeded",
    };
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.updated", { id: partialRefund.id }),
    );
    mocks.retrieveRefund.mockResolvedValue(partialRefund);
    mocks.listRefunds.mockResolvedValue({
      data: [partialRefund],
      has_more: false,
    });

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeInvoiceId: "in_pro_1",
        billingPeriodStart: new Date(1_786_060_800_000),
        billingPeriodEnd: new Date(1_788_739_200_000),
        paymentAmount: 2_000,
        reversalAmount: 400,
        active: false,
      }),
    );
  });

  it("holds Pro access for a refunded first invoice, whose period is on its lines", async () => {
    mockProInvoicePaymentContext();
    // 定期請求の初回請求書。Stripe はトップレベルの period を同じ瞬間にし、実際に
    // 買われた期間は明細行だけが持つ。ここを読み落とすと、初回の全額返金が
    // 「期間の取れない請求」として黙って捨てられ、利用権が残ってしまう。
    mocks.retrieveInvoice.mockResolvedValue({
      id: "in_pro_1",
      amount_paid: 2_000,
      currency: "usd",
      customer: "cus_1",
      status: "paid",
      parent: {
        subscription_details: { subscription: "sub_pro_1" },
      },
      period_start: 1_786_060_800,
      period_end: 1_786_060_800,
      lines: {
        data: [
          {
            period: { start: 1_786_060_800, end: 1_788_739_200 },
          },
        ],
      },
    });
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_pro_first" }),
    );
    const refund = {
      id: "re_pro_first",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "succeeded",
    };
    mocks.retrieveRefund.mockResolvedValue(refund);
    mocks.listRefunds.mockResolvedValue({ data: [refund], has_more: false });

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_pro_1",
        stripeReversalKind: "refund",
        stripeReversalId: "re_pro_first",
        billingPeriodStart: new Date(1_786_060_800 * 1_000),
        billingPeriodEnd: new Date(1_788_739_200 * 1_000),
        active: true,
      }),
    );
  });

  it("holds Pro access for a refund and restores it when the refund fails", async () => {
    mockProInvoicePaymentContext();
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: "re_pro_1" }),
    );
    const pendingRefund = {
      id: "re_pro_1",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "pending",
    };
    mocks.retrieveRefund.mockResolvedValue(pendingRefund);
    mocks.listRefunds.mockResolvedValue({ data: [pendingRefund], has_more: false });

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_pro_1",
        stripeReversalKind: "refund",
        stripeReversalId: "re_pro_1",
        status: "pending",
        active: true,
      }),
    );

    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.failed", { id: "re_pro_1" }, 1_786_060_901),
    );
    const failedRefund = {
      id: "re_pro_1",
      payment_intent: "pi_pro_invoice",
      amount: 2_000,
      currency: "usd",
      status: "failed",
    };
    mocks.retrieveRefund.mockResolvedValue(failedRefund);
    mocks.listRefunds.mockResolvedValue({ data: [failedRefund], has_more: false });

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeReversalKind: "refund",
        stripeReversalId: "re_pro_1",
        status: "failed",
        active: false,
      }),
    );
  });

  it("holds a multi-payment Pro invoice only while all paid value is reversed", async () => {
    const { refundsByPaymentIntent } = mockMultiPaymentProInvoice();
    const firstRefund = {
      id: "re_pro_1",
      payment_intent: "pi_pro_1",
      amount: 1_000,
      currency: "usd",
      status: "succeeded",
    };
    refundsByPaymentIntent.set("pi_pro_1", [firstRefund]);
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: firstRefund.id }),
    );

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripeInvoiceId: "in_pro_1",
        paymentAmount: 2_000,
        reversalAmount: 1_000,
        active: false,
      }),
    );

    const secondRefund = {
      id: "re_pro_2",
      payment_intent: "pi_pro_2",
      amount: 1_000,
      currency: "usd",
      status: "pending",
    };
    refundsByPaymentIntent.set("pi_pro_2", [secondRefund]);
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.created", { id: secondRefund.id }, 1_786_060_901),
    );

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripePaymentIntentId: "pi_pro_2",
        paymentAmount: 2_000,
        reversalAmount: 2_000,
        active: true,
      }),
    );

    const failedSecondRefund = { ...secondRefund, status: "failed" };
    refundsByPaymentIntent.set("pi_pro_2", [failedSecondRefund]);
    mocks.constructEvent.mockReturnValue(
      stripeEvent("refund.failed", { id: secondRefund.id }, 1_786_060_902),
    );

    expect((await POST(webhookRequest() as never)).status).toBe(200);
    expect(mocks.reconcileSubscriptionEntitlementHold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stripePaymentIntentId: "pi_pro_2",
        paymentAmount: 2_000,
        reversalAmount: 1_000,
        status: "failed",
        active: false,
      }),
    );
    expect(mocks.listInvoicePayments).toHaveBeenCalledWith({
      invoice: "in_pro_1",
      status: "paid",
      limit: 100,
      starting_after: "inpay_pro_1",
    });
  });

  it.each([
    ["customer", { customer: "cus_other", currency: "usd" }],
    ["currency", { customer: "cus_1", currency: "eur" }],
  ])(
    "does not change a Pro hold when another invoice payment has a mismatched %s",
    async (_field, mismatchedPayment) => {
      const { paymentIntents, refundsByPaymentIntent } =
        mockMultiPaymentProInvoice();
      paymentIntents.set("pi_pro_2", {
        ...paymentIntents.get("pi_pro_2")!,
        ...mismatchedPayment,
      });
      const refund = {
        id: "re_pro_validation",
        payment_intent: "pi_pro_1",
        amount: 1_000,
        currency: "usd",
        status: "succeeded",
      };
      refundsByPaymentIntent.set("pi_pro_1", [refund]);
      mocks.constructEvent.mockReturnValue(
        stripeEvent("refund.created", { id: refund.id }),
      );

      expect((await POST(webhookRequest() as never)).status).toBe(200);
      expect(
        mocks.reconcileSubscriptionEntitlementHold,
      ).not.toHaveBeenCalled();
    },
  );
});
