import {
  claimTopUpRefundAttempt,
  prepareTopUpsForAccountDeletion,
  recordTopUpRefund,
  requireTopUpRefund,
  rescheduleTopUpRefundAttempt,
  setTopUpCheckoutSession,
  setDbProvider,
} from "@beutl/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processTopUpRefunds,
  TOP_UP_REFUND_BASE_RETRY_MS,
  TOP_UP_REFUND_MAX_ATTEMPTS,
} from "../../packages/api/src/ai/top-up-refunds";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const now = new Date("2026-08-11T13:00:00.000Z");

describe("durable top-up refund processing", () => {
  let database: ReturnType<typeof createInMemoryPrisma>;
  let checkoutRetrieve: ReturnType<typeof vi.fn>;
  let checkoutExpire: ReturnType<typeof vi.fn>;
  let paymentIntentRetrieve: ReturnType<typeof vi.fn>;
  let refundCreate: ReturnType<typeof vi.fn>;
  let refundList: ReturnType<typeof vi.fn>;
  let refundRetrieve: ReturnType<typeof vi.fn>;
  let stripe: any;

  beforeEach(() => {
    database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    checkoutRetrieve = vi.fn();
    checkoutExpire = vi.fn();
    paymentIntentRetrieve = vi.fn();
    refundCreate = vi.fn();
    refundList = vi.fn().mockResolvedValue({ data: [] });
    refundRetrieve = vi.fn();
    stripe = {
      checkout: {
        sessions: {
          retrieve: checkoutRetrieve,
          expire: checkoutExpire,
        },
      },
      paymentIntents: { retrieve: paymentIntentRetrieve },
      refunds: {
        create: refundCreate,
        list: refundList,
        retrieve: refundRetrieve,
      },
    };
  });

  function seedAttempt(
    overrides: Partial<
      Parameters<typeof database.state.topUpCheckoutAttempts.set>[1]
    > = {},
  ) {
    const attempt = {
      id: "attempt-1",
      ownerUserId: "deleted-user",
      stripeCustomerId: "cus_1",
      billingOfferId: "offer_top_up_v1",
      stripeCheckoutSessionId: "cs_1",
      stripePaymentIntentId: null,
      status: "refund_required",
      expiresAt: new Date("2026-08-12T13:00:00.000Z"),
      accountDeletionAt: now,
      fulfilledAt: null,
      refundId: null,
      refundStatus: null,
      refundStatusObservedAt: null,
      refundTargetAmount: null,
      refundSucceededAmount: 0,
      refundPendingAmount: 0,
      refundCurrency: null,
      refundNotBefore: now,
      refundLeaseToken: null,
      refundLeaseExpiresAt: null,
      refundAttempts: 0,
      refundLastError: null,
      refundInterventionAt: null,
      createdAt: new Date("2026-08-11T12:00:00.000Z"),
      updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      ...overrides,
    };
    database.state.topUpCheckoutAttempts.set(attempt.id, attempt);
    return attempt;
  }

  it("claims a due refund once with a transactionally persisted lease", async () => {
    seedAttempt();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);

    const [first, second] = await Promise.all([
      claimTopUpRefundAttempt({
        attemptId: "attempt-1",
        now,
        leaseToken: "lease-1",
        leaseExpiresAt,
        maxAttempts: TOP_UP_REFUND_MAX_ATTEMPTS,
      }),
      claimTopUpRefundAttempt({
        attemptId: "attempt-1",
        now,
        leaseToken: "lease-2",
        leaseExpiresAt,
        maxAttempts: TOP_UP_REFUND_MAX_ATTEMPTS,
      }),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual([
      "claimed",
      "not-claimed",
    ]);
    const leased = database.state.topUpCheckoutAttempts.get("attempt-1")!;
    expect(leased.refundAttempts).toBe(1);
    expect(["lease-1", "lease-2"]).toContain(leased.refundLeaseToken);
    await expect(
      rescheduleTopUpRefundAttempt({
        attemptId: "attempt-1",
        refundLeaseToken:
          leased.refundLeaseToken === "lease-1" ? "lease-2" : "lease-1",
        refundNotBefore: new Date(now.getTime() + 10_000),
        refundLastError: "stale worker",
      }),
    ).resolves.toBe(false);
  });

  it("retains a Checkout Session created concurrently with account deletion without redirecting to it", async () => {
    seedAttempt({ stripeCheckoutSessionId: null });
    const expiresAt = new Date("2026-08-12T14:00:00.000Z");

    await expect(
      setTopUpCheckoutSession({
        attemptId: "attempt-1",
        stripeCheckoutSessionId: "cs_raced",
        expiresAt,
      }),
    ).resolves.toBe("stored-for-refund");
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_required",
      stripeCheckoutSessionId: "cs_raced",
      expiresAt,
    });
  });

  it("accepts an exact terminal Checkout binding during deletion retry", async () => {
    seedAttempt({
      status: "refunded",
      stripeCheckoutSessionId: "cs_terminal",
      refundId: "re_terminal",
      refundStatus: "succeeded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 1_000,
      refundNotBefore: null,
    });

    await expect(setTopUpCheckoutSession({
      attemptId: "attempt-1",
      stripeCheckoutSessionId: "cs_terminal",
      expiresAt: new Date("2026-08-12T14:00:00.000Z"),
    })).resolves.toBe("already-bound");
    await expect(setTopUpCheckoutSession({
      attemptId: "attempt-1",
      stripeCheckoutSessionId: "cs_other",
      expiresAt: new Date("2026-08-12T14:00:00.000Z"),
    })).resolves.toBe("not-stored");
  });

  it.each(["refund_not_required", "expired"])(
    "reopens %s when a delayed PaymentIntent arrives",
    async (status) => {
      seedAttempt({
        status,
        stripeCheckoutSessionId: null,
        accountDeletionAt: status === "expired" ? null : now,
        refundStatus: status === "refund_not_required" ? "not_required" : null,
        refundNotBefore: null,
      });

      await expect(requireTopUpRefund({
        attemptId: "attempt-1",
        stripePaymentIntentId: "pi_late",
        now,
      })).resolves.toEqual({ count: 1 });
      expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
        status: "refund_required",
        stripePaymentIntentId: "pi_late",
        accountDeletionAt: now,
        refundNotBefore: now,
        refundAttempts: 0,
        refundInterventionAt: null,
      });
    },
  );

  it("records a pending late refund directly from refund_not_required", async () => {
    seedAttempt({
      status: "refund_not_required",
      stripeCheckoutSessionId: null,
      refundStatus: "not_required",
      refundNotBefore: null,
    });

    await expect(recordTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_late_pending",
      refundId: "re_late_pending",
      refundStatus: "pending",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 0,
      refundPendingAmount: 1_000,
      refundCurrency: "usd",
      now,
    })).resolves.toEqual({ count: 1 });
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_pending",
      stripePaymentIntentId: "pi_late_pending",
      refundId: "re_late_pending",
      refundNotBefore: now,
    });
  });

  it("records a failed late refund directly from an expired attempt", async () => {
    seedAttempt({
      status: "expired",
      stripeCheckoutSessionId: null,
      accountDeletionAt: null,
      refundNotBefore: null,
    });

    await expect(recordTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_late_failed",
      refundId: "re_late_failed",
      refundStatus: "failed",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 0,
      refundPendingAmount: 0,
      refundCurrency: "usd",
      now,
    })).resolves.toEqual({ count: 1 });
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_failed",
      stripePaymentIntentId: "pi_late_failed",
      refundId: "re_late_failed",
      accountDeletionAt: now,
      refundNotBefore: now,
    });
  });

  it("never lets stale refund observations or refund requirements regress refunded", async () => {
    seedAttempt({ stripePaymentIntentId: "pi_1" });

    await recordTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_1",
      refundId: "re_1",
      refundStatus: "succeeded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 1_000,
      refundPendingAmount: 0,
      refundCurrency: "usd",
      now,
    });
    const stale = await recordTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_1",
      refundId: "re_1",
      refundStatus: "pending",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 0,
      refundPendingAmount: 1_000,
      refundCurrency: "usd",
      now: new Date(now.getTime() + 1_000),
    });
    const required = await requireTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_1",
      now: new Date(now.getTime() + 2_000),
    });

    expect(stale.count).toBe(0);
    expect(required.count).toBe(0);
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refunded",
      refundId: "re_1",
      refundStatus: "succeeded",
      refundNotBefore: null,
    });
  });

  it("preserves refund_failed while account deletion and stale pending observations retry", async () => {
    seedAttempt({
      stripePaymentIntentId: "pi_1",
      status: "refund_failed",
      refundId: "re_1",
      refundStatus: "failed",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 0,
      refundPendingAmount: 0,
      refundCurrency: "usd",
    });

    await prepareTopUpsForAccountDeletion({
      ownerUserId: "deleted-user",
      now: new Date(now.getTime() + 1_000),
      prisma: database.prisma as any,
    });
    await requireTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_1",
      now: new Date(now.getTime() + 2_000),
    });
    const stale = await recordTopUpRefund({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi_1",
      refundId: "re_1",
      refundStatus: "pending",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 0,
      refundPendingAmount: 1_000,
      refundCurrency: "usd",
      now: new Date(now.getTime() + 3_000),
    });

    expect(stale.count).toBe(0);
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_failed",
      refundStatus: "failed",
    });
  });

  it("expires an account-deletion Checkout Session that is still open and unpaid", async () => {
    seedAttempt();
    checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      status: "open",
      payment_status: "unpaid",
      payment_intent: null,
    });
    checkoutExpire.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      status: "expired",
      payment_status: "unpaid",
      payment_intent: null,
    });

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      claimed: 1,
      noRefundRequired: 1,
      errors: 0,
    });
    expect(checkoutExpire).toHaveBeenCalledWith("cs_1", {
      idempotencyKey: "beutl:ai-top-up-expire:attempt-1",
    });
    expect(refundCreate).not.toHaveBeenCalled();
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_not_required",
      refundStatus: "not_required",
      refundLeaseToken: null,
    });
  });

  it("closes an account-deletion zero-cost Checkout without a refund", async () => {
    database.state.billingOffers.set("offer_top_up_v1", {
      id: "offer_top_up_v1",
      kind: "top_up",
      stripePriceId: "price_top_up",
      stripeProductId: "prod_top_up",
      unitAmount: 1_000,
      currency: "usd",
      creditAmount: 500,
      recurringInterval: null,
      recurringIntervalCount: null,
      checkoutEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    seedAttempt({
      paramsJson: JSON.stringify({ allow_promotion_codes: true }),
    });
    checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      status: "complete",
      payment_status: "no_payment_required",
      payment_intent: null,
      mode: "payment",
      amount_subtotal: 1_000,
      amount_total: 0,
      currency: "usd",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "deleted-user",
        topUpAttemptId: "attempt-1",
        billingOfferId: "offer_top_up_v1",
        creditAmount: "500",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_top_up" } }],
      },
    });

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      claimed: 1,
      noRefundRequired: 1,
      interventionRequired: 0,
      errors: 0,
    });
    expect(checkoutExpire).not.toHaveBeenCalled();
    expect(paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(refundCreate).not.toHaveBeenCalled();
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_not_required",
      refundStatus: "not_required",
      refundLeaseToken: null,
    });
  });

  it("resolves Checkout to PaymentIntent, creates one idempotent refund, and records canonical success", async () => {
    seedAttempt();
    checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_1",
    });
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      status: "succeeded",
      amount_received: 1_000,
      currency: "usd",
    });
    const succeededRefund = {
      id: "re_1",
      payment_intent: "pi_1",
      amount: 1_000,
      currency: "usd",
      status: "succeeded",
      metadata: { topUpAttemptId: "attempt-1" },
    };
    refundCreate.mockResolvedValue(succeededRefund);
    refundList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [succeededRefund], has_more: false });

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      refunded: 1,
      pending: 0,
      errors: 0,
    });
    expect(refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_1",
        amount: 1_000,
        metadata: {
          beutlDisposition: "unfulfillable-ai-top-up",
          topUpAttemptId: "attempt-1",
          refundTargetAmount: "1000",
          refundSucceededAmountBeforeCreate: "0",
        },
      },
      { idempotencyKey: "beutl:ai-top-up-refund:attempt-1:0:1000" },
    );
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      stripePaymentIntentId: "pi_1",
      refundId: "re_1",
      refundStatus: "succeeded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 1_000,
      status: "refunded",
    });
  });

  it("aggregates partial refunds and refunds only the remaining PaymentIntent amount", async () => {
    seedAttempt({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_1",
    });
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      status: "succeeded",
      amount_received: 1_000,
      currency: "usd",
    });
    const firstPartial = {
      id: "re_partial_1",
      payment_intent: "pi_1",
      amount: 250,
      currency: "usd",
      status: "succeeded",
      metadata: {},
    };
    const secondPartial = {
      id: "re_partial_2",
      payment_intent: "pi_1",
      amount: 150,
      currency: "usd",
      status: "succeeded",
      metadata: {},
    };
    const remainder = {
      id: "re_remaining",
      payment_intent: "pi_1",
      amount: 600,
      currency: "usd",
      status: "succeeded",
      metadata: { topUpAttemptId: "attempt-1" },
    };
    refundCreate.mockResolvedValue(remainder);
    refundList
      .mockResolvedValueOnce({
        data: [firstPartial, secondPartial],
        has_more: false,
      })
      .mockResolvedValueOnce({
        data: [remainder, firstPartial, secondPartial],
        has_more: false,
      });

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      refunded: 1,
      errors: 0,
    });
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 600 }),
      expect.any(Object),
    );
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refunded",
      refundTargetAmount: 1_000,
      refundSucceededAmount: 1_000,
      refundPendingAmount: 0,
    });
  });

  it("recovers an ambiguous create response without issuing a second refund", async () => {
    seedAttempt({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_1",
    });
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      status: "succeeded",
      amount_received: 1_000,
      currency: "usd",
    });
    refundList
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({
        data: [
          {
            id: "re_1",
            payment_intent: "pi_1",
            amount: 1_000,
            currency: "usd",
            status: "succeeded",
            metadata: { topUpAttemptId: "attempt-1" },
          },
        ],
        has_more: false,
      });
    refundCreate.mockRejectedValueOnce(
      new Error("connection closed after write"),
    );

    const first = await processTopUpRefunds({ stripe, now });
    expect(first).toMatchObject({ errors: 1, pending: 1, refunded: 0 });
    const retryAt = database.state.topUpCheckoutAttempts.get("attempt-1")!
      .refundNotBefore!;
    expect(retryAt).toEqual(
      new Date(now.getTime() + TOP_UP_REFUND_BASE_RETRY_MS),
    );

    const second = await processTopUpRefunds({ stripe, now: retryAt });
    expect(second).toMatchObject({ errors: 0, refunded: 1 });
    expect(refundCreate).toHaveBeenCalledTimes(1);
    expect(refundCreate).toHaveBeenCalledWith(
      expect.any(Object),
      { idempotencyKey: "beutl:ai-top-up-refund:attempt-1:0:1000" },
    );
    expect(refundList).toHaveBeenCalledTimes(2);
  });

  it("polls canonical pending status with bounded exponential backoff", async () => {
    seedAttempt({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_1",
      status: "refund_pending",
      refundId: "re_1",
      refundStatus: "pending",
    });
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      status: "succeeded",
      amount_received: 1_000,
      currency: "usd",
    });
    refundList.mockResolvedValue({
      data: [{
        id: "re_1",
        payment_intent: "pi_1",
        amount: 1_000,
        currency: "usd",
        status: "pending",
        metadata: { topUpAttemptId: "attempt-1" },
      }],
      has_more: false,
    });

    await processTopUpRefunds({ stripe, now });
    const firstRetryAt = database.state.topUpCheckoutAttempts.get("attempt-1")!
      .refundNotBefore!;
    expect(firstRetryAt).toEqual(
      new Date(now.getTime() + TOP_UP_REFUND_BASE_RETRY_MS),
    );

    await processTopUpRefunds({ stripe, now: firstRetryAt });
    const secondRetryAt = database.state.topUpCheckoutAttempts.get("attempt-1")!
      .refundNotBefore!;
    expect(secondRetryAt).toEqual(
      new Date(firstRetryAt.getTime() + 2 * TOP_UP_REFUND_BASE_RETRY_MS),
    );
    expect(refundList).toHaveBeenCalledTimes(2);
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("escalates a canonical failed refund for an alternative refund method", async () => {
    seedAttempt({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_1",
      status: "refund_failed",
      refundId: "re_1",
      refundStatus: "failed",
    });
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_1",
      customer: "cus_1",
      status: "succeeded",
      amount_received: 1_000,
      currency: "usd",
    });
    refundList.mockResolvedValue({
      data: [{
        id: "re_1",
        payment_intent: "pi_1",
        amount: 1_000,
        currency: "usd",
        status: "failed",
        metadata: { topUpAttemptId: "attempt-1" },
      }],
      has_more: false,
    });

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      refunded: 0,
      errors: 0,
      interventionRequired: 1,
    });
    expect(refundCreate).not.toHaveBeenCalled();
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_failed",
      refundInterventionAt: now,
      refundNotBefore: null,
      refundLeaseToken: null,
      refundLastError:
        "Stripe refund re_1 reached failed; an alternative refund method is required",
    });
  });

  it("persists an intervention state when the bounded attempt count is reached", async () => {
    seedAttempt({
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: "pi_1",
      refundAttempts: TOP_UP_REFUND_MAX_ATTEMPTS - 1,
    });
    paymentIntentRetrieve.mockRejectedValue(new Error("Stripe unavailable"));

    await expect(processTopUpRefunds({ stripe, now })).resolves.toMatchObject({
      claimed: 1,
      errors: 1,
      interventionRequired: 1,
      pending: 0,
    });
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      refundAttempts: TOP_UP_REFUND_MAX_ATTEMPTS,
      refundInterventionAt: now,
      refundLastError: "Stripe unavailable",
      refundNotBefore: null,
      refundLeaseToken: null,
    });
  });
});
