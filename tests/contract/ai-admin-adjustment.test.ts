import { beforeEach, describe, expect, it } from "vitest";
import {
  addPurchasedCredits,
  adjustPurchasedCreditsByAdmin,
  consumeUsage,
  CreditAdjustmentRejectedError,
  getCreditAccount,
  reconcilePurchasedCreditReversal,
  setDbProvider,
  setMonthlyUsageUsedByAdmin,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "user-admin-adjustment";
const PERIOD = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};
const NEXT_PERIOD = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};
const MONTHLY_LIMIT = 500;

describe("administrator credit adjustments", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
  });

  it("grants credits and records the adjustment in the ledger", async () => {
    const account = await adjustPurchasedCreditsByAdmin({
      userId: USER_ID,
      creditDelta: 250,
    });

    expect(account.purchasedCredits).toBe(250);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(state.creditTransactions).toHaveLength(1);
    expect(state.creditTransactions[0]).toMatchObject({
      userId: USER_ID,
      kind: "admin_credit_adjustment",
      creditAmount: 250,
      debtAmount: 0,
      usageAmount: 0,
    });
  });

  it("settles outstanding debt before adding spendable credits", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_admin_1",
      stripePayment: { amount: 1000, currency: "jpy" },
    });
    await reconcilePurchasedCreditReversal({
      stripePaymentId: "pi_admin_1",
      stripePayment: { amount: 1000, currency: "jpy" },
      reversalKind: "refund",
      reversalId: "re_admin_1",
      reversalAmount: 1000,
      reversalCurrency: "jpy",
      status: "succeeded",
      active: true,
      stripeEventId: "evt_admin_1",
      stripeEventCreatedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    // The refund landed after the credits were spent, so the account owes 500.
    const owing = await getCreditAccount({ userId: USER_ID });
    expect(owing.purchasedCredits).toBe(0);
    expect(owing.purchasedCreditDebt).toBe(0);

    await consumeUsage({
      userId: USER_ID,
      amount: 400,
      monthlyUsageLimit: 0,
      usagePeriod: PERIOD,
      aiJobId: "job-debt-setup",
    }).catch(() => undefined);

    await adjustPurchasedCreditsByAdmin({ userId: USER_ID, creditDelta: 300 });
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(300);
  });

  it("pays down debt first when the account owes credits", async () => {
    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: "pi_admin_2",
      stripePayment: { amount: 1000, currency: "jpy" },
    });
    await consumeUsage({
      userId: USER_ID,
      amount: 500,
      monthlyUsageLimit: 0,
      usagePeriod: PERIOD,
      aiJobId: "job-spend",
    });
    await reconcilePurchasedCreditReversal({
      stripePaymentId: "pi_admin_2",
      stripePayment: { amount: 1000, currency: "jpy" },
      reversalKind: "refund",
      reversalId: "re_admin_2",
      reversalAmount: 1000,
      reversalCurrency: "jpy",
      status: "succeeded",
      active: true,
      stripeEventId: "evt_admin_2",
      stripeEventCreatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    const indebted = await getCreditAccount({ userId: USER_ID });
    expect(indebted.purchasedCreditDebt).toBe(500);

    const account = await adjustPurchasedCreditsByAdmin({
      userId: USER_ID,
      creditDelta: 300,
    });
    expect(account.purchasedCreditDebt).toBe(200);
    expect(account.purchasedCredits).toBe(0);
    expect(state.creditTransactions.at(-1)).toMatchObject({
      kind: "admin_credit_adjustment",
      creditAmount: 300,
      debtAmount: -300,
    });
  });

  it("revokes credits down to the current balance", async () => {
    await adjustPurchasedCreditsByAdmin({ userId: USER_ID, creditDelta: 100 });

    const account = await adjustPurchasedCreditsByAdmin({
      userId: USER_ID,
      creditDelta: -60,
    });
    expect(account.purchasedCredits).toBe(40);
    expect(account.purchasedCreditDebt).toBe(0);
    expect(state.creditTransactions.at(-1)).toMatchObject({
      kind: "admin_credit_adjustment",
      creditAmount: -60,
      debtAmount: 0,
    });
  });

  it("rejects a revoke that exceeds the balance instead of creating debt", async () => {
    await adjustPurchasedCreditsByAdmin({ userId: USER_ID, creditDelta: 50 });

    await expect(
      adjustPurchasedCreditsByAdmin({ userId: USER_ID, creditDelta: -51 }),
    ).rejects.toBeInstanceOf(CreditAdjustmentRejectedError);

    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(50);
    expect(account.purchasedCreditDebt).toBe(0);
    // The rejected attempt must leave no ledger row behind.
    expect(state.creditTransactions).toHaveLength(1);
  });

  it.each([0, 1.5, Number.NaN])(
    "rejects the invalid credit delta %s",
    async (delta) => {
      await expect(
        adjustPurchasedCreditsByAdmin({ userId: USER_ID, creditDelta: delta }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );
});

describe("administrator monthly usage adjustments", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
  });

  it("sets the consumed amount and records the difference", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: 300,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
      aiJobId: "job-usage-1",
    });

    const account = await setMonthlyUsageUsedByAdmin({
      userId: USER_ID,
      monthlyUsageUsed: 100,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
    });

    expect(account.monthlyUsageUsed).toBe(100);
    expect(state.creditTransactions.at(-1)).toMatchObject({
      kind: "admin_usage_adjustment",
      creditAmount: 0,
      usageAmount: -200,
      usagePeriodStart: PERIOD.start,
      usagePeriodEnd: PERIOD.end,
    });
  });

  it("restores the full allowance when reset to zero", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
      aiJobId: "job-usage-2",
    });

    const account = await setMonthlyUsageUsedByAdmin({
      userId: USER_ID,
      monthlyUsageUsed: 0,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
    });
    expect(account.monthlyUsageUsed).toBe(0);

    // The allowance is spendable again right away.
    const spent = await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
      aiJobId: "job-usage-3",
    });
    expect(spent.monthlyUsageUsed).toBe(MONTHLY_LIMIT);
    expect(spent.purchasedCredits).toBe(0);
  });

  it("writes no ledger row when the value does not change", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: 120,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
      aiJobId: "job-usage-4",
    });
    const before = state.creditTransactions.length;

    await setMonthlyUsageUsedByAdmin({
      userId: USER_ID,
      monthlyUsageUsed: 120,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
    });

    expect(state.creditTransactions).toHaveLength(before);
  });

  it("rejects a value above the allowance", async () => {
    await expect(
      setMonthlyUsageUsedByAdmin({
        userId: USER_ID,
        monthlyUsageUsed: MONTHLY_LIMIT + 1,
        monthlyUsageLimit: MONTHLY_LIMIT,
        usagePeriod: PERIOD,
      }),
    ).rejects.toBeInstanceOf(CreditAdjustmentRejectedError);
  });

  it("applies the adjustment after the period roll-over resets usage", async () => {
    await consumeUsage({
      userId: USER_ID,
      amount: 400,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: PERIOD,
      aiJobId: "job-usage-5",
    });

    // A renewal resets the counter first; the adjustment must land on the new
    // period rather than being undone by the next lazy reset.
    const account = await setMonthlyUsageUsedByAdmin({
      userId: USER_ID,
      monthlyUsageUsed: 50,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: NEXT_PERIOD,
    });

    expect(account.monthlyUsageUsed).toBe(50);
    expect(account.usagePeriodStart).toEqual(NEXT_PERIOD.start);
    expect(state.creditTransactions.at(-1)).toMatchObject({
      kind: "admin_usage_adjustment",
      usageAmount: 50,
    });
  });
});
