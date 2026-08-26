import { describe, expect, it, vi } from "vitest";
import {
  bindProCheckoutSession,
  deleteProCheckoutAttempt,
  getOrCreateProCheckoutAttempt,
} from "../../packages/db/src/pro-checkout-attempt";

describe("Pro checkout attempts", () => {
  it("keeps an expired local lease when a Checkout Session is already bound", async () => {
    const now = new Date("2026-08-12T00:00:00.000Z");
    const existing = {
      userId: "user-1",
      checkoutKey: "attempt-old",
      billingOfferId: "offer-old",
      stripeCheckoutSessionId: "cs_still_open",
      expiresAt: new Date("2026-08-11T00:00:00.000Z"),
    };
    const transaction = {
      accountDeletionIntent: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      proCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn(),
      },
    };

    await expect(
      getOrCreateProCheckoutAttempt({
        userId: "user-1",
        billingOfferId: "offer-current",
        now,
        customerId: "cus_1",
        expiresAt: new Date("2026-08-13T00:00:00.000Z"),
        prisma: transaction as never,
      }),
    ).resolves.toBe(existing);

    expect(transaction.proCheckoutAttempt.upsert).not.toHaveBeenCalled();
  });

  it("deletes only the Checkout Session named by the cleanup caller", async () => {
    const transaction = {
      proCheckoutAttempt: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(
      deleteProCheckoutAttempt({
        userId: "user-1",
        stripeCheckoutSessionId: "cs_old",
        prisma: transaction as never,
      }),
    ).resolves.toBe(true);

    expect(transaction.proCheckoutAttempt.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        stripeCheckoutSessionId: "cs_old",
      },
    });
  });

  it("preserves a post-cascade bound Session and writes cleanup outbox from stored customerId", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      proCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "user-1", checkoutKey: "key-1", billingOfferId: "offer-1",
          stripeCheckoutSessionId: null, customerId: "cus_1", accountDeletionAt: new Date(),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      stripeCheckoutCleanup: { upsert, findUnique: vi.fn().mockResolvedValue(null), create: upsert, update: vi.fn() },
    };
    await expect(bindProCheckoutSession({
      userId: "user-1",
      checkoutKey: "key-1",
      stripeCheckoutSessionId: "cs_late",
      expiresAt: new Date(),
      prisma: transaction as never,
    })).resolves.toBe("account-deletion-authorized");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sessionId: "cs_late", customerId: "cus_1" }),
    }));
  });
});
