import { beforeEach, describe, expect, it } from "vitest";
import { setDbProvider } from "@beutl/db";
import {
  addPurchasedCredits,
  AiUsageLimitExceededError,
  bindProCheckoutSession,
  consumeUsage,
  expireProCheckoutAttempt,
  getCreditAccount,
  getCreditPurchasesByUserId,
  getOrCreateProCheckoutAttempt,
  getMonthlyUsageAccount,
  reconcilePurchasedCreditReversal,
  refundUsage,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "user-credit-ledger";
const PERIOD_ONE = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};
const PERIOD_TWO = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};

let stripeEventSequence = 0;

function nextStripeObservation() {
  const sequence = ++stripeEventSequence;
  return {
    stripeEventId: `evt_credit_reversal_${sequence}`,
    stripeEventCreatedAt: new Date(1_786_060_800_000 + sequence * 1000),
  };
}

describe("AI usage ledger", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    stripeEventSequence = 0;
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
  });

  it("creates an empty account on first access", async () => {
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(0);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(state.creditAccounts.has(USER_ID)).toBe(true);
  });

  it("adds only purchased credits and records the Stripe payment", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_1",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(500);
    expect(state.creditTransactions[0]).toMatchObject({
      userId: USER_ID,
      creditAmount: 500,
      debtAmount: 0,
      usageAmount: 0,
      kind: "purchase",
      stripePaymentId: "pi_1",
    });
  });

  it("exposes only money-in rows so usage cost stays private", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_history",
      stripePayment: { amount: 1000, currency: "jpy" },
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 20,
      usagePeriod: PERIOD_ONE,
      monthlyUsageLimit: 500,
    });

    const purchases = await getCreditPurchasesByUserId({ userId: USER_ID });

    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      kind: "purchase",
      stripePaymentId: "pi_history",
      stripePaymentAmount: 1000,
      stripeCurrency: "jpy",
    });
    expect(purchases.some((item) => item.usageAmount !== 0)).toBe(false);
  });

  it("reports how much of a purchase a refund reversed", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_partial",
      stripePayment: { amount: 1000, currency: "jpy" },
    });
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_full",
      stripePayment: { amount: 1000, currency: "jpy" },
    });

    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      stripePaymentId: "pi_partial",
      stripePayment: { amount: 1000, currency: "jpy" },
      reversalKind: "refund",
      reversalId: "re_partial",
      reversalAmount: 400,
      reversalCurrency: "jpy",
      status: "succeeded",
      active: true,
    });
    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      stripePaymentId: "pi_full",
      stripePayment: { amount: 1000, currency: "jpy" },
      reversalKind: "refund",
      reversalId: "re_full",
      reversalAmount: 1000,
      reversalCurrency: "jpy",
      status: "succeeded",
      active: true,
    });

    const purchases = await getCreditPurchasesByUserId({ userId: USER_ID });
    const partial = purchases.find(
      (item) => item.stripePaymentId === "pi_partial",
    );
    const full = purchases.find((item) => item.stripePaymentId === "pi_full");

    expect(partial).toMatchObject({
      reversedCredits: 200,
      isFullyReversed: false,
    });
    expect(full).toMatchObject({
      reversedCredits: 500,
      isFullyReversed: true,
    });
  });

  it("handles a duplicate Stripe payment idempotently", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_duplicate",
    });
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_duplicate",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(500);
    expect(state.creditTransactions).toHaveLength(1);
  });

  it("consumes the monthly allowance before purchased credits", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 200,
      stripePaymentId: "pi_1",
    });

    await consumeUsage({
      userId: USER_ID,
      amount: 300,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });
    let account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(300);
    expect(account.purchasedCredits).toBe(200);

    await consumeUsage({
      userId: USER_ID,
      amount: 300,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-2",
    });
    account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(500);
    expect(account.purchasedCredits).toBe(100);

    const usages = state.creditTransactions.filter(
      (transaction) => transaction.kind === "usage",
    );
    expect(usages[0]).toMatchObject({
      creditAmount: 0,
      usageAmount: 300,
    });
    expect(usages[1]).toMatchObject({
      creditAmount: -100,
      usageAmount: 200,
    });
  });

  it("rolls monthly usage over without expiring purchased credits", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 75,
      stripePaymentId: "pi_1",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 120,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });

    const account = await getMonthlyUsageAccount({
      userId: USER_ID,
      usagePeriod: PERIOD_TWO,
    });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(75);
    expect(account.usagePeriodStart).toEqual(PERIOD_TWO.start);
    expect(account.usagePeriodEnd).toEqual(PERIOD_TWO.end);
  });

  it("preserves usage when Stripe adjusts only the current period end", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: 120,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });
    const adjustedPeriod = {
      start: PERIOD_ONE.start,
      end: new Date("2026-09-03T00:00:00.000Z"),
    };

    const account = await getMonthlyUsageAccount({
      userId: USER_ID,
      usagePeriod: adjustedPeriod,
    });

    expect(account.monthlyUsageUsed).toBe(120);
    expect(account.usagePeriodStart).toEqual(adjustedPeriod.start);
    expect(account.usagePeriodEnd).toEqual(adjustedPeriod.end);
  });

  it("leaves the account unchanged when the allowance and credits are insufficient", async () => {
    await expect(
      consumeUsage({
        userId: USER_ID,
        amount: 101,
        monthlyUsageLimit: 100,
        usagePeriod: PERIOD_ONE,
        aiJobId: "job-1",
      }),
    ).rejects.toBeInstanceOf(AiUsageLimitExceededError);

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(0);
    expect(
      state.creditTransactions.filter(
        (transaction) => transaction.kind === "usage",
      ),
    ).toHaveLength(0);
  });

  it("handles a repeated charge for the same AI job idempotently", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: 20,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 20,
      monthlyUsageLimit: 500,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(20);
    expect(
      state.creditTransactions.filter(
        (transaction) => transaction.kind === "usage",
      ),
    ).toHaveLength(1);
  });

  it("restores the original monthly and purchased split exactly once", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 100,
      stripePaymentId: "pi_1",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 150,
      monthlyUsageLimit: 100,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });

    await refundUsage({
      userId: USER_ID,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });
    await refundUsage({
      userId: USER_ID,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(100);
    const refunds = state.creditTransactions.filter(
      (transaction) => transaction.kind === "refund",
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      creditAmount: 50,
      usageAmount: -100,
      aiJobId: "job-1",
    });
  });

  it("restores purchased credits but not an expired monthly allowance", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 100,
      stripePaymentId: "pi_1",
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 150,
      monthlyUsageLimit: 100,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-1",
    });

    await refundUsage({
      userId: USER_ID,
      usagePeriod: PERIOD_TWO,
      aiJobId: "job-1",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(100);
    expect(
      state.creditTransactions.find(
        (transaction) => transaction.kind === "refund",
      ),
    ).toMatchObject({
      creditAmount: 50,
      usageAmount: 0,
    });
  });

  it("turns spent reversed credits into debt and makes a later purchase pay it first", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_reversed",
      stripePayment: { amount: 1000, currency: "usd" },
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 400,
      monthlyUsageLimit: 0,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-spent",
    });

    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      stripePaymentId: "pi_reversed",
      stripePayment: { amount: 1000, currency: "usd" },
      reversalKind: "refund",
      reversalId: "re_full",
      reversalAmount: 1000,
      reversalCurrency: "usd",
      status: "succeeded",
      active: true,
    });

    let account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(0);
    expect(account.purchasedCreditDebt).toBe(400);

    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_next",
      stripePayment: { amount: 1000, currency: "usd" },
    });

    account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(100);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(
      state.creditTransactions.find(
        (transaction) => transaction.stripePaymentId === "pi_next",
      ),
    ).toMatchObject({
      creditAmount: 500,
      debtAmount: -400,
    });
  });

  it("restores a failed refund once from its latest canonical state", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_refund",
      stripePayment: { amount: 1000, currency: "usd" },
    });
    const refund = {
      stripePaymentId: "pi_refund",
      stripePayment: { amount: 1000, currency: "usd" },
      reversalKind: "refund" as const,
      reversalId: "re_partial",
      reversalAmount: 400,
      reversalCurrency: "usd",
    };

    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      ...refund,
      status: "succeeded",
      active: true,
    });
    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      ...refund,
      status: "succeeded",
      active: true,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCredits).toBe(
      300,
    );

    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      ...refund,
      status: "failed",
      active: false,
    });
    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      ...refund,
      status: "failed",
      active: false,
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(500);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(
      state.creditTransactions.filter(
        (transaction) => transaction.kind === "purchase_reversal",
      ),
    ).toHaveLength(2);
    expect(state.stripeCreditReversals.get("refund:re_partial")?.revision).toBe(
      2,
    );
  });

  it("aggregates partial reversals, avoids per-event rounding, and caps overlap at the purchase", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_overlap",
      stripePayment: { amount: 1000, currency: "usd" },
    });
    const reconcile = async ({
      kind,
      id,
      amount,
      status,
      active,
    }: {
      kind: "refund" | "dispute";
      id: string;
      amount: number;
      status: string;
      active: boolean;
    }) =>
      reconcilePurchasedCreditReversal({
        ...nextStripeObservation(),
        stripePaymentId: "pi_overlap",
        stripePayment: { amount: 1000, currency: "usd" },
        reversalKind: kind,
        reversalId: id,
        reversalAmount: amount,
        reversalCurrency: "usd",
        status,
        active,
      });

    await reconcile({
      kind: "refund",
      id: "re_one",
      amount: 333,
      status: "succeeded",
      active: true,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCredits).toBe(
      333,
    );

    await reconcile({
      kind: "refund",
      id: "re_two",
      amount: 333,
      status: "succeeded",
      active: true,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCredits).toBe(
      167,
    );

    await reconcile({
      kind: "dispute",
      id: "dp_full",
      amount: 1000,
      status: "needs_response",
      active: true,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCredits).toBe(
      0,
    );

    await reconcile({
      kind: "refund",
      id: "re_one",
      amount: 333,
      status: "failed",
      active: false,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCredits).toBe(
      0,
    );

    await reconcile({
      kind: "dispute",
      id: "dp_full",
      amount: 1000,
      status: "won",
      active: false,
    });
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(333);
    expect(account.purchasedCreditDebt).toBe(0);
    const netReversed = -state.creditTransactions
      .filter((transaction) => transaction.kind === "purchase_reversal")
      .reduce((total, transaction) => total + transaction.creditAmount, 0);
    expect(netReversed).toBe(167);
  });

  it("applies a reversal that arrives before its PaymentIntent grant", async () => {
    const result = await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      stripePaymentId: "pi_late",
      stripePayment: { amount: 1000, currency: "usd" },
      reversalKind: "refund",
      reversalId: "re_early",
      reversalAmount: 500,
      reversalCurrency: "usd",
      status: "succeeded",
      active: true,
    });
    expect(result).toBeNull();
    expect(state.creditTransactions).toHaveLength(0);

    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_late",
      stripePayment: { amount: 1000, currency: "usd" },
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(250);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(
      state.creditTransactions.filter(
        (transaction) => transaction.kind === "purchase_reversal",
      ),
    ).toHaveLength(1);
  });

  it("uses a provider usage refund to settle reversal debt before restoring credits", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_usage_refund",
      stripePayment: { amount: 1000, currency: "usd" },
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 500,
      monthlyUsageLimit: 0,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-refunded-after-reversal",
    });
    await reconcilePurchasedCreditReversal({
      ...nextStripeObservation(),
      stripePaymentId: "pi_usage_refund",
      stripePayment: { amount: 1000, currency: "usd" },
      reversalKind: "dispute",
      reversalId: "dp_spent",
      reversalAmount: 1000,
      reversalCurrency: "usd",
      status: "lost",
      active: true,
    });
    expect((await getCreditAccount({ userId: USER_ID })).purchasedCreditDebt).toBe(
      500,
    );

    await refundUsage({
      userId: USER_ID,
      usagePeriod: PERIOD_ONE,
      aiJobId: "job-refunded-after-reversal",
    });

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(0);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(
      state.creditTransactions.find(
        (transaction) =>
          transaction.kind === "refund" &&
          transaction.aiJobId === "job-refunded-after-reversal",
      ),
    ).toMatchObject({
      creditAmount: 500,
      debtAmount: -500,
    });
  });

  it("reuses an active Pro checkout attempt and rotates it after expiry", async () => {
    const now = new Date("2026-08-08T00:00:00.000Z");
    const expiresAt = new Date("2026-08-09T00:00:00.000Z");
    const first = await getOrCreateProCheckoutAttempt({
      userId: USER_ID,
      billingOfferId: "offer-pro-v1",
      now,
      expiresAt,
    });
    const second = await getOrCreateProCheckoutAttempt({
      userId: USER_ID,
      billingOfferId: "offer-pro-v1",
      now,
      expiresAt,
    });
    await expireProCheckoutAttempt({
      userId: USER_ID,
      checkoutKey: first.checkoutKey,
      now,
    });
    const replacement = await getOrCreateProCheckoutAttempt({
      userId: USER_ID,
      billingOfferId: "offer-pro-v1",
      now,
      expiresAt,
    });

    expect(second.checkoutKey).toBe(first.checkoutKey);
    expect(replacement.checkoutKey).not.toBe(first.checkoutKey);
  });

  it("keeps a live Stripe session bound across a billing-offer rotation", async () => {
    const now = new Date("2026-08-08T00:00:00.000Z");
    const expiresAt = new Date("2026-08-09T00:00:00.000Z");
    const first = await getOrCreateProCheckoutAttempt({
      userId: USER_ID,
      billingOfferId: "offer-pro-v1",
      now,
      expiresAt,
    });
    await expect(
      bindProCheckoutSession({
        userId: USER_ID,
        checkoutKey: first.checkoutKey,
        stripeCheckoutSessionId: "cs_live",
        expiresAt,
      }),
    ).resolves.toBe("bound");

    const afterRotation = await getOrCreateProCheckoutAttempt({
      userId: USER_ID,
      billingOfferId: "offer-pro-v2",
      now,
      expiresAt,
    });

    expect(afterRotation).toMatchObject({
      checkoutKey: first.checkoutKey,
      billingOfferId: "offer-pro-v1",
      stripeCheckoutSessionId: "cs_live",
    });
  });

  it("refuses a Pro checkout attempt after account deletion is authorized", async () => {
    const now = new Date("2026-08-08T00:00:00.000Z");
    state.accountDeletionIntents.set("delete-user", {
      identifier: "owner@example.com",
      tokenHash: "delete-token",
      userId: USER_ID,
      stripeCustomerId: "cus_1",
      authorizedAt: new Date(now.getTime() - 1_000),
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      getOrCreateProCheckoutAttempt({
        userId: USER_ID,
        billingOfferId: "offer-pro-v1",
        now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      }),
    ).rejects.toThrow("Account deletion is already authorized");
    expect(state.proCheckoutAttempts.size).toBe(0);
  });
});
