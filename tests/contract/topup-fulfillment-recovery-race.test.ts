import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ addPurchasedCredits: vi.fn() }));

vi.mock("../../packages/db/src/credit-account", () => ({
  addPurchasedCredits: mocks.addPurchasedCredits,
}));

import { fulfillTopUpCheckoutAttempt } from "../../packages/db/src/top-up-checkout-attempt";
import {
  finalizeTopUpCheckoutResolutionAtomically,
  scheduleTopUpCheckoutResolution,
} from "../../packages/db/src/topup-checkout-resolution";

describe("top-up webhook versus multiple-Session recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for recovery, refunds the duplicate, then grants canonical credits", async () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    const attempt: Record<string, any> = {
      id: "attempt-1",
      ownerUserId: "user-1",
      activeOwnerKey: "user-1",
      checkoutKey: "ai-top-up-checkout:attempt-1",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      status: "open",
      accountDeletionAt: null,
      createLeaseToken: "recovery-lease",
      createLeaseExpiresAt: new Date(now.getTime() + 60_000),
      recoveryLeaseToken: "recovery-lease",
      recoveryLeaseExpiresAt: new Date(now.getTime() + 60_000),
      recoveryNotBefore: null,
      updatedAt: now,
      billingOffer: {
        id: "offer-1",
        kind: "top_up",
        unitAmount: 1_000,
        currency: "usd",
        creditAmount: 500,
      },
    };
    const resolutions: Record<string, any>[] = [];
    const refunds: Record<string, any>[] = [];
    const tx = {
      user: { findUnique: vi.fn(async () => ({ id: "user-1" })) },
      accountDeletionIntent: { findFirst: vi.fn(async () => null) },
      topUpCheckoutAttempt: {
        findUnique: vi.fn(async () => ({ ...attempt })),
        findFirst: vi.fn(async ({ where }: any) =>
          attempt.id === where.id &&
          attempt.recoveryLeaseToken === where.recoveryLeaseToken &&
          attempt.createLeaseToken === where.createLeaseToken &&
          attempt.stripeCheckoutSessionId === where.stripeCheckoutSessionId
            ? { id: attempt.id }
            : null),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (
            attempt.id !== where.id ||
            (where.updatedAt &&
              attempt.updatedAt.getTime() !== where.updatedAt.getTime())
          ) return { count: 0 };
          Object.assign(attempt, data, { updatedAt: new Date(now.getTime() + 1) });
          return { count: 1 };
        }),
      },
      topUpCheckoutResolution: {
        findUnique: vi.fn(async () => resolutions[0] ?? null),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: "resolution-1", revision: 0, ...data };
          resolutions.push(row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = resolutions[0];
          if (
            !row ||
            (where.id !== undefined && row.id !== where.id) ||
            (where.revision !== undefined && row.revision !== where.revision) ||
            (where.status !== undefined && row.status !== where.status)
          ) return { count: 0 };
          const revision = data.revision;
          Object.assign(row, data, {
            revision: revision?.increment
              ? row.revision + revision.increment
              : row.revision,
          });
          return { count: 1 };
        }),
      },
      topUpDuplicateRefundAttempt: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => refunds.map((row) => ({
          stripePaymentIntentId: row.stripePaymentIntentId,
          status: row.status,
        }))),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: "refund-1", ...data };
          refunds.push(row);
          return row;
        }),
      },
    };

    await expect(fulfillTopUpCheckoutAttempt({
      attemptId: "attempt-1",
      stripePaymentIntentId: "pi-canonical",
      stripePayment: { amount: 1_000, currency: "usd" },
      stripeRefundState: { succeededAmount: 0, pendingAmount: 0 },
      now,
      prisma: tx as never,
    })).resolves.toMatchObject({ status: "recovery-pending" });
    expect(attempt).toMatchObject({
      status: "open",
      createLeaseToken: "recovery-lease",
      recoveryLeaseToken: "recovery-lease",
    });
    expect(mocks.addPurchasedCredits).not.toHaveBeenCalled();

    await expect(scheduleTopUpCheckoutResolution({
      topUpAttemptId: "attempt-1",
      recoveryLeaseToken: "recovery-lease",
      ownerUserId: "user-1",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      canonicalSessionId: "cs-canonical",
      canonicalPaymentIntentId: "pi-canonical",
      expectedPaymentIntents: [{
        paymentIntentId: "pi-duplicate",
        amount: 1_000,
        currency: "usd",
      }],
      prisma: tx as never,
    })).resolves.toMatchObject({
      canonicalPaymentIntentId: "pi-canonical",
      status: "refund_pending",
    });
    expect(refunds).toEqual([
      expect.objectContaining({
        stripePaymentIntentId: "pi-duplicate",
        status: "required",
      }),
    ]);
    refunds[0]!.status = "refunded";

    await expect(finalizeTopUpCheckoutResolutionAtomically({
      topUpAttemptId: "attempt-1",
      recoveryLeaseToken: "recovery-lease",
      finalization: {
        outcome: "fulfill",
        sessionId: "cs-canonical",
        expiresAt: new Date(now.getTime() + 60_000),
        paymentIntentId: "pi-canonical",
        stripePayment: { amount: 1_000, currency: "usd" },
      },
      prisma: tx as never,
    })).resolves.toBe(true);
    expect(attempt).toMatchObject({
      status: "fulfilled",
      stripeCheckoutSessionId: "cs-canonical",
      stripePaymentIntentId: "pi-canonical",
      activeOwnerKey: null,
      createLeaseToken: null,
      recoveryLeaseToken: null,
    });
    expect(resolutions[0]).toMatchObject({ status: "resolved" });
    expect(mocks.addPurchasedCredits).toHaveBeenCalledTimes(1);
  });

  it("routes a second PaymentIntent on a fulfilled legacy attempt to the duplicate outbox", async () => {
    const duplicateRefunds: Record<string, any>[] = [];
    const attempt = {
      id: "fulfilled-attempt",
      ownerUserId: "user-1",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      stripePaymentIntentId: "pi-canonical",
      stripeCheckoutSessionId: "cs-canonical",
      status: "fulfilled",
      accountDeletionAt: null,
      createLeaseToken: null,
      recoveryLeaseToken: null,
      billingOffer: {
        id: "offer-1",
        kind: "top_up",
        unitAmount: 1_000,
        currency: "usd",
        creditAmount: 500,
      },
    };
    const tx = {
      topUpCheckoutAttempt: {
        findUnique: vi.fn(async () => attempt),
      },
      topUpCheckoutResolution: {
        findUnique: vi.fn(async () => null),
      },
      topUpDuplicateRefundAttempt: {
        findUnique: vi.fn(async ({ where }: any) =>
          duplicateRefunds.find((row) =>
            row.stripePaymentIntentId === where.stripePaymentIntentId) ?? null),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: "duplicate-refund-1", ...data };
          duplicateRefunds.push(row);
          return row;
        }),
      },
    };

    for (let replay = 0; replay < 2; replay++) {
      await expect(fulfillTopUpCheckoutAttempt({
        attemptId: "fulfilled-attempt",
        stripePaymentIntentId: "pi-duplicate",
        stripePayment: { amount: 1_000, currency: "usd" },
        stripeRefundState: { succeededAmount: 400, pendingAmount: 0 },
        prisma: tx as never,
      })).resolves.toEqual({ status: "duplicate-refund-required" });
    }

    expect(duplicateRefunds).toEqual([
      expect.objectContaining({
        topUpAttemptId: "fulfilled-attempt",
        stripePaymentIntentId: "pi-duplicate",
        status: "required",
      }),
    ]);
    expect(mocks.addPurchasedCredits).not.toHaveBeenCalled();
  });
});
