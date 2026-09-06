import {
  recordBillingRefundState,
  scheduleBillingRefundAttempt,
  setDbProvider,
} from "@beutl/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_REFUND_BASE_RETRY_MS,
  BILLING_REFUND_MAX_ATTEMPTS,
  processBillingRefunds,
} from "../../packages/api/src/ai/billing-refunds";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const now = new Date("2026-08-11T15:00:00.000Z");

describe("durable billing refund processing", () => {
  let database: ReturnType<typeof createInMemoryPrisma>;
  let subscriptionRetrieve: ReturnType<typeof vi.fn>;
  let subscriptionCancel: ReturnType<typeof vi.fn>;
  let paymentIntentRetrieve: ReturnType<typeof vi.fn>;
  let invoicePaymentList: ReturnType<typeof vi.fn>;
  let invoiceRetrieve: ReturnType<typeof vi.fn>;
  let refundList: ReturnType<typeof vi.fn>;
  let refundCreate: ReturnType<typeof vi.fn>;
  let stripe: any;

  beforeEach(() => {
    database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    subscriptionRetrieve = vi.fn().mockResolvedValue({
      id: "sub_1",
      customer: "cus_old",
      status: "active",
    });
    subscriptionCancel = vi.fn().mockResolvedValue({
      id: "sub_1",
      customer: "cus_old",
      status: "canceled",
    });
    paymentIntentRetrieve = vi.fn().mockResolvedValue({
      id: "pi_1",
      customer: "cus_old",
      status: "succeeded",
      amount_received: 2_000,
      currency: "usd",
    });
    invoicePaymentList = vi.fn().mockResolvedValue({
      data: [],
      has_more: false,
    });
    invoiceRetrieve = vi.fn().mockResolvedValue({
      id: "in_1",
      customer: "cus_old",
      status: "void",
      amount_paid: 0,
    });
    refundList = vi.fn().mockResolvedValue({ data: [], has_more: false });
    refundCreate = vi.fn();
    stripe = {
      subscriptions: {
        retrieve: subscriptionRetrieve,
        cancel: subscriptionCancel,
      },
      paymentIntents: { retrieve: paymentIntentRetrieve },
      invoicePayments: { list: invoicePaymentList },
      invoices: { retrieve: invoiceRetrieve },
      refunds: { list: refundList, create: refundCreate },
    };
  });

  async function schedule(stripePaymentIntentId: string | null = "pi_1") {
    return await scheduleBillingRefundAttempt({
      disposition: "superseded-pro-checkout",
      sourceKey: `cs_1:${stripePaymentIntentId ?? "no-payment"}`,
      stripeCustomerId: "cus_old",
      stripeCheckoutSessionId: "cs_1",
      stripeSubscriptionId: "sub_1",
      stripeInvoiceId: "in_1",
      stripePaymentIntentId,
      now,
    });
  }

  it("cancels the superseded subscription and durably completes a full refund", async () => {
    const attempt = await schedule();
    const succeededRefund = {
      id: "re_1",
      payment_intent: "pi_1",
      amount: 2_000,
      currency: "usd",
      status: "succeeded",
      metadata: { billingRefundAttemptId: attempt!.id },
    };
    refundCreate.mockResolvedValue(succeededRefund);
    refundList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [succeededRefund], has_more: false });

    await expect(processBillingRefunds({ stripe, now })).resolves.toMatchObject({
      claimed: 1,
      refunded: 1,
      errors: 0,
    });
    expect(subscriptionCancel).toHaveBeenCalledWith(
      "sub_1",
      { invoice_now: false, prorate: false },
      { idempotencyKey: "beutl:billing-refund-cancel:cs_1:pi_1" },
    );
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_1",
        amount: 2_000,
        metadata: expect.objectContaining({
          billingRefundAttemptId: attempt!.id,
          checkoutSessionId: "cs_1",
        }),
      }),
      {
        idempotencyKey:
          `beutl:billing-refund:${attempt!.id}:0:2000`,
      },
    );
    expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
      status: "refunded",
      cancellationCompletedAt: now,
      targetAmount: 2_000,
      succeededAmount: 2_000,
      pendingAmount: 0,
      refundId: "re_1",
      interventionAt: null,
    });
  });

  it("aggregates multiple partial refunds and creates only the remaining amount", async () => {
    const attempt = await schedule();
    const partials = [
      {
        id: "re_external_1",
        payment_intent: "pi_1",
        amount: 500,
        currency: "usd",
        status: "succeeded",
        metadata: {},
      },
      {
        id: "re_external_2",
        payment_intent: "pi_1",
        amount: 700,
        currency: "usd",
        status: "succeeded",
        metadata: {},
      },
    ];
    const remainder = {
      id: "re_remaining",
      payment_intent: "pi_1",
      amount: 800,
      currency: "usd",
      status: "succeeded",
      metadata: { billingRefundAttemptId: attempt!.id },
    };
    refundCreate.mockResolvedValue(remainder);
    refundList
      .mockResolvedValueOnce({ data: partials, has_more: false })
      .mockResolvedValueOnce({
        data: [remainder, ...partials],
        has_more: false,
      });

    await expect(processBillingRefunds({ stripe, now })).resolves.toMatchObject({
      refunded: 1,
      errors: 0,
    });
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 800 }),
      expect.any(Object),
    );
    expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
      status: "refunded",
      succeededAmount: 2_000,
    });
  });

  it("recovers an ambiguous refund create from durable metadata", async () => {
    const attempt = await schedule();
    const recovered = {
      id: "re_recovered",
      payment_intent: "pi_1",
      amount: 2_000,
      currency: "usd",
      status: "succeeded",
      metadata: { billingRefundAttemptId: attempt!.id },
    };
    refundList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [recovered], has_more: false });
    refundCreate.mockRejectedValueOnce(new Error("connection closed after write"));

    const first = await processBillingRefunds({ stripe, now });
    expect(first).toMatchObject({ errors: 1, pending: 1 });
    const retryAt = database.state.billingRefundAttempts.get(attempt!.id)!
      .notBefore!;
    expect(retryAt).toEqual(
      new Date(now.getTime() + BILLING_REFUND_BASE_RETRY_MS),
    );

    const second = await processBillingRefunds({ stripe, now: retryAt });
    expect(second).toMatchObject({ refunded: 1, errors: 0 });
    expect(refundCreate).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "canceled", "requires_action"])(
    "persists intervention when a managed refund becomes %s",
    async (status) => {
      const attempt = await schedule();
      refundList.mockResolvedValue({
        data: [{
          id: "re_failed",
          payment_intent: "pi_1",
          amount: 2_000,
          currency: "usd",
          status,
          metadata: { billingRefundAttemptId: attempt!.id },
        }],
        has_more: false,
      });

      await expect(processBillingRefunds({ stripe, now })).resolves.toMatchObject({
        interventionRequired: 1,
        errors: 0,
      });
      expect(refundCreate).not.toHaveBeenCalled();
      expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
        status: "intervention_required",
        interventionAt: now,
        notBefore: null,
        leaseToken: null,
      });
    },
  );

  it("terminalizes a true no-payment invoice without creating a refund", async () => {
    const attempt = await schedule(null);

    await expect(processBillingRefunds({ stripe, now })).resolves.toMatchObject({
      noRefundRequired: 1,
      errors: 0,
    });
    expect(paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(refundCreate).not.toHaveBeenCalled();
    expect(invoiceRetrieve).toHaveBeenCalledWith("in_1");
    expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
      status: "no_refund_required",
      cancellationCompletedAt: now,
    });
  });

  it("fully refunds a payment that appears after the first settlement scan", async () => {
    const placeholder = await schedule(null);
    invoicePaymentList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({
        data: [{
          id: "ip_late",
          amount_paid: 2_000,
          payment: { type: "payment_intent", payment_intent: "pi_late" },
        }],
        has_more: false,
      });
    invoiceRetrieve.mockResolvedValueOnce({
      id: "in_1",
      customer: "cus_old",
      status: "open",
      amount_paid: 0,
    });

    await expect(processBillingRefunds({ stripe, now })).resolves.toMatchObject({
      noRefundRequired: 0,
      pending: 1,
      errors: 0,
    });
    const retryAt = database.state.billingRefundAttempts.get(placeholder!.id)!
      .notBefore!;
    expect(retryAt).toEqual(
      new Date(now.getTime() + BILLING_REFUND_BASE_RETRY_MS),
    );
    expect(database.state.billingRefundAttempts.get(placeholder!.id)).toMatchObject({
      status: "required",
      lastError:
        "Invoice in_1 remains open with 0 paid units and no settled PaymentIntent",
    });

    await expect(
      processBillingRefunds({ stripe, now: retryAt }),
    ).resolves.toMatchObject({
      noRefundRequired: 1,
      errors: 0,
    });
    const discovered = [...database.state.billingRefundAttempts.values()].find(
      (attempt) => attempt.stripePaymentIntentId === "pi_late",
    );
    expect(discovered).toMatchObject({
      sourceKey: "cs_1:pi_late",
      status: "required",
      stripeInvoiceId: "in_1",
      notBefore: retryAt,
    });
    expect(database.state.billingRefundAttempts.get(placeholder!.id)).toMatchObject({
      status: "no_refund_required",
    });

    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_late",
      customer: "cus_old",
      status: "succeeded",
      amount_received: 2_000,
      currency: "usd",
    });
    const succeededRefund = {
      id: "re_late",
      payment_intent: "pi_late",
      amount: 2_000,
      currency: "usd",
      status: "succeeded",
      metadata: { billingRefundAttemptId: discovered!.id },
    };
    refundCreate.mockResolvedValue(succeededRefund);
    refundList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({
        data: [succeededRefund],
        has_more: false,
      });

    await expect(
      processBillingRefunds({ stripe, now: retryAt }),
    ).resolves.toMatchObject({
      refunded: 1,
      errors: 0,
    });
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_late", amount: 2_000 }),
      expect.objectContaining({
        idempotencyKey:
          `beutl:billing-refund:${discovered!.id}:0:2000`,
      }),
    );
    expect(database.state.billingRefundAttempts.get(discovered!.id)).toMatchObject({
      status: "refunded",
      targetAmount: 2_000,
      succeededAmount: 2_000,
      pendingAmount: 0,
      refundId: "re_late",
    });
  });

  it("escalates an invoice whose payment settlement never becomes terminal", async () => {
    const attempt = await schedule(null);
    invoiceRetrieve.mockResolvedValue({
      id: "in_1",
      customer: "cus_old",
      status: "open",
      amount_paid: 0,
    });
    let processAt = now;

    for (let index = 0; index < BILLING_REFUND_MAX_ATTEMPTS; index++) {
      const result = await processBillingRefunds({ stripe, now: processAt });
      if (index < BILLING_REFUND_MAX_ATTEMPTS - 1) {
        expect(result).toMatchObject({ pending: 1, interventionRequired: 0 });
        processAt = database.state.billingRefundAttempts.get(attempt!.id)!
          .notBefore!;
      } else {
        expect(result).toMatchObject({ pending: 0, interventionRequired: 1 });
      }
    }

    expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
      status: "intervention_required",
      interventionAt: processAt,
      notBefore: null,
      leaseToken: null,
      lastError:
        "Invoice in_1 remains open with 0 paid units and no settled PaymentIntent",
    });
  });

  it("never regresses a fully refunded attempt from a stale partial observation", async () => {
    const attempt = await schedule();
    await recordBillingRefundState({
      attemptId: attempt!.id,
      stripePaymentIntentId: "pi_1",
      targetAmount: 2_000,
      succeededAmount: 2_000,
      pendingAmount: 0,
      currency: "usd",
      refundId: "re_full",
      refundStatus: "succeeded",
      observedAt: now,
    });
    const stale = await recordBillingRefundState({
      attemptId: attempt!.id,
      stripePaymentIntentId: "pi_1",
      targetAmount: 2_000,
      succeededAmount: 500,
      pendingAmount: 1_500,
      currency: "usd",
      refundId: "re_partial",
      refundStatus: "pending",
      observedAt: new Date(now.getTime() + 1_000),
    });

    expect(stale.count).toBe(0);
    expect(database.state.billingRefundAttempts.get(attempt!.id)).toMatchObject({
      status: "refunded",
      succeededAmount: 2_000,
      refundId: "re_full",
    });
  });
});
