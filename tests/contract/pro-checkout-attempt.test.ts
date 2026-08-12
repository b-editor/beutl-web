import { describe, expect, it, vi } from "vitest";
import {
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
});
