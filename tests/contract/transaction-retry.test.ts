import { describe, expect, it, vi } from "vitest";
import {
  authorizeAccountDeletionIntent,
  consumeUsage,
  reconcileSubscriptionEntitlementHold,
  reconcileSubscriptionObservation,
  setDbProvider,
  startRetryableTransaction,
  startTransaction,
} from "@beutl/db";

describe("database transactions", () => {
  it("retries CockroachDB write conflicts", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("write conflict"), { code: "P2034" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("write conflict"), { code: "P2034" }),
      )
      .mockImplementation(async (callback) => callback({}));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await startRetryableTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-conflict failures", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("invalid data"));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(
      startRetryableTransaction(async () => "unused"),
    ).rejects.toThrow("invalid data");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("passes interactive transaction options to every attempt", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("write conflict"), { code: "P2034" }),
      )
      .mockImplementation(async (callback) => callback({}));
    setDbProvider(async () => ({ $transaction: transaction }) as never);
    const options = { isolationLevel: "Serializable" as const };

    await startRetryableTransaction(async () => "completed", options);

    expect(transaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      options,
    );
    expect(transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      options,
    );
  });

  it("retries adapter write conflicts raised while committing", async () => {
    const adapterConflict = Object.assign(
      new Error("TransactionWriteConflict"),
      {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      },
    );
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(adapterConflict)
      .mockImplementation(async (callback) => callback({}));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await startRetryableTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not replay ordinary transaction callbacks", async () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const callback = vi.fn(async () => "unused");
    const transaction = vi.fn(async (run) => {
      await run({});
      throw conflict;
    });
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(startTransaction(callback)).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("retries a database-only AI usage reservation after a commit conflict", async () => {
    const account = {
      userId: "user-1",
      monthlyUsageUsed: 0,
      purchasedCredits: 100,
      purchasedCreditDebt: 0,
      usagePeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      usagePeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    };
    const tx = {
      creditAccount: {
        upsert: vi.fn().mockResolvedValue(account),
        update: vi.fn().mockImplementation(async ({ data }: {
          data: Record<string, unknown>;
        }) => ({
          ...account,
          ...data,
        })),
      },
      creditTransaction: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "usage-1" }),
      },
    };
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (callback: (value: typeof tx) => Promise<unknown>) => {
        await callback(tx);
        throw conflict;
      })
      .mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await consumeUsage({
      userId: "user-1",
      amount: 50,
      monthlyUsageLimit: 500,
      usagePeriod: {
        start: account.usagePeriodStart,
        end: account.usagePeriodEnd,
      },
      aiJobId: "job-1",
    });

    expect(result.monthlyUsageUsed).toBe(50);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.creditTransaction.create).toHaveBeenCalledTimes(2);
  });

  it("retries each subscription CAS transaction after a commit conflict", async () => {
    const oldEventTime = new Date("2026-08-11T00:00:00.000Z");
    const stored = {
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      billingOfferId: "offer_pro_1",
      stripeEventId: "evt_old",
      stripeEventCreatedAt: oldEventTime,
      stripeCanonicalObservedAt: oldEventTime,
      stripeObservationRank: "old-rank",
    };
    const tx = {
      subscription: {
        findUnique: vi.fn().mockResolvedValue(stored),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (callback: (value: typeof tx) => Promise<unknown>) => {
        await callback(tx);
        throw conflict;
      })
      .mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await reconcileSubscriptionObservation({
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      currentPeriodStart: stored.currentPeriodStart,
      currentPeriodEnd: stored.currentPeriodEnd,
      cancelAtPeriodEnd: true,
      cancelAt: new Date("2026-08-20T00:00:00.000Z"),
      billingOfferId: "offer_pro_1",
      stripeSubscriptionCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
      stripeEventId: "evt_new",
      stripeEventCreatedAt: new Date("2026-08-11T00:01:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:01:01.000Z"),
    });

    expect(result.applied).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.subscription.updateMany).toHaveBeenCalledTimes(2);
  });

  it("retries entitlement-hold reconciliation after a commit conflict", async () => {
    const existingHold = {
      id: "hold-1",
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      stripePaymentIntentId: "pi_1",
      stripeReversalKind: "dispute",
      stripeReversalId: "dp_1",
      stripeInvoiceId: "in_1",
      billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      billingPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      paymentAmount: 2_000,
      reversalAmount: 2_000,
      currency: "usd",
      status: "under_review",
      active: true,
      progressionRank: 10,
      stripeEventId: "evt_old",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    };
    const tx = {
      subscriptionEntitlementHold: {
        upsert: vi.fn().mockResolvedValue(existingHold),
        findFirst: vi.fn().mockResolvedValue(existingHold),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          ...existingHold,
          status: "won",
          active: false,
          progressionRank: 100,
        }),
      },
    };
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (callback: (value: typeof tx) => Promise<unknown>) => {
        await callback(tx);
        throw conflict;
      })
      .mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await reconcileSubscriptionEntitlementHold({
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      stripePaymentIntentId: "pi_1",
      stripeReversalKind: "dispute",
      stripeReversalId: "dp_1",
      stripeInvoiceId: "in_1",
      billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      billingPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      paymentAmount: 2_000,
      reversalAmount: 2_000,
      currency: "usd",
      status: "won",
      active: false,
      stripeEventId: "evt_new",
      stripeEventCreatedAt: new Date("2026-08-11T00:01:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:01:01.000Z"),
    });

    expect(result.applied).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.subscriptionEntitlementHold.updateMany).toHaveBeenCalledTimes(4);
  });

  it("retries account-deletion authorization and its outbox snapshot after a commit conflict", async () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    const intent = {
      identifier: "owner@example.com",
      tokenHash: "token-hash",
      userId: "user-1",
      stripeCustomerId: null,
      authorizedAt: now,
      expiresAt: new Date("2026-08-18T00:00:00.000Z"),
    };
    const tx = {
      accountDeletionIntent: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(intent),
      },
      confirmationToken: {
        findUnique: vi.fn().mockResolvedValue({
          expires: new Date("2026-08-12T00:00:00.000Z"),
          purpose: "ACCOUNT_DELETE",
          userId: "user-1",
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      customer: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      proCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      packageCheckoutAttempt: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      package: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      stripeCheckoutCleanup: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      stripeCustomerProvisioning: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
      topUpCheckoutAttempt: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      topUpDuplicateRefundAttempt: { count: vi.fn().mockResolvedValue(0) },
      topUpCheckoutResolution: { count: vi.fn().mockResolvedValue(0) },
      aiJob: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      aiRemoteJobCleanup: {
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (callback: (value: typeof tx) => Promise<unknown>) => {
        await callback(tx);
        throw conflict;
      })
      .mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(
      authorizeAccountDeletionIntent({
        identifier: intent.identifier,
        tokenHash: intent.tokenHash,
        now,
      }),
    ).resolves.toMatchObject({ status: "authorized", resumed: false });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.confirmationToken.deleteMany).toHaveBeenCalledTimes(2);
    expect(tx.proCheckoutAttempt.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.topUpCheckoutAttempt.updateMany).toHaveBeenCalledTimes(4);
    expect(tx.aiJob.findMany).toHaveBeenCalledTimes(2);
  });
});
