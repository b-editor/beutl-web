import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findTopUpCheckoutAttempt: vi.fn(),
  fulfillTopUpCheckoutAttempt: vi.fn(),
  recordTopUpRefund: vi.fn(),
  requireTopUpRefund: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  findTopUpCheckoutAttempt: mocks.findTopUpCheckoutAttempt,
  fulfillTopUpCheckoutAttempt: mocks.fulfillTopUpCheckoutAttempt,
  recordTopUpRefund: mocks.recordTopUpRefund,
  requireTopUpRefund: mocks.requireTopUpRefund,
}));

import { fulfillOrRefundTopUpPayment } from "../../apps/web/src/lib/stripe/ai-billing";

const paymentIntent = {
  id: "pi_delayed",
  status: "succeeded",
  customer: "cus_1",
  amount_received: 1_000,
  currency: "usd",
  metadata: {
    beutlApplication: "beutl-web",
    beutlUserId: "user-1",
    creditAmount: "500",
    billingOfferId: "offer_top_up_v1",
    topUpAttemptId: "attempt-1",
  },
} as any;

const attempt = {
  id: "attempt-1",
  ownerUserId: "user-1",
  stripeCustomerId: "cus_1",
  billingOfferId: "offer_top_up_v1",
  billingOffer: {
    id: "offer_top_up_v1",
    kind: "top_up",
    stripePriceId: "price_top_up_v1",
    stripeProductId: "prod_top_up",
    unitAmount: 1_000,
    currency: "usd",
    creditAmount: 500,
    recurringInterval: null,
    recurringIntervalCount: null,
    checkoutEnabled: false,
  },
};

describe("durable top-up fulfillment", () => {
  const createRefund = vi.fn();
  const listRefunds = vi.fn();
  const retrievePaymentIntent = vi.fn();
  const stripe = {
    paymentIntents: { retrieve: retrievePaymentIntent },
    refunds: { create: createRefund, list: listRefunds },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTopUpCheckoutAttempt.mockResolvedValue(attempt);
    retrievePaymentIntent.mockResolvedValue(paymentIntent);
    const succeededRefund = {
      id: "re_1",
      payment_intent: "pi_delayed",
      amount: 1_000,
      currency: "usd",
      status: "succeeded",
      metadata: { topUpAttemptId: "attempt-1" },
    };
    createRefund.mockResolvedValue(succeededRefund);
    listRefunds
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [succeededRefund], has_more: false });
  });

  it("fulfills against the persisted attempt after its offer is retired", async () => {
    mocks.fulfillTopUpCheckoutAttempt.mockResolvedValue({
      status: "fulfilled",
      userId: "user-1",
      creditAmount: 500,
    });

    await expect(
      fulfillOrRefundTopUpPayment(stripe, paymentIntent),
    ).resolves.toMatchObject({ status: "fulfilled", creditAmount: 500 });
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("idempotently refunds a delayed success after account deletion", async () => {
    mocks.fulfillTopUpCheckoutAttempt.mockResolvedValue({
      status: "refund-required",
    });

    await expect(
      fulfillOrRefundTopUpPayment(stripe, paymentIntent),
    ).resolves.toEqual({ status: "refund-requested", refundId: "re_1" });
    expect(createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_delayed", amount: 1_000 }),
      {
        idempotencyKey:
          "beutl:ai-top-up-refund:attempt-1:0:1000",
      },
    );
    expect(mocks.recordTopUpRefund).toHaveBeenLastCalledWith({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_delayed",
      refundId: "re_1",
      refundStatus: "succeeded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 1_000,
      refundPendingAmount: 0,
      refundCurrency: "usd",
    });
  });

  it("does not start an untracked refund without a persisted attempt", async () => {
    mocks.findTopUpCheckoutAttempt.mockResolvedValue(null);
    const legacyPayment = {
      ...paymentIntent,
      id: "pi_legacy_delayed",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        creditAmount: "500",
      },
    };

    await expect(
      fulfillOrRefundTopUpPayment(stripe, legacyPayment),
    ).resolves.toEqual({ status: "unrecognized" });
    expect(createRefund).not.toHaveBeenCalled();
    expect(mocks.requireTopUpRefund).not.toHaveBeenCalled();
  });
});
