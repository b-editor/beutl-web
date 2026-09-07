import { describe, expect, it, vi } from "vitest";
import {
  bindSubscriptionCheckoutSession,
  deleteSubscriptionCheckoutAttempt,
  getOrCreateSubscriptionCheckoutAttempt,
} from "../../packages/db/src/subscription-checkout-attempt";

describe("storage checkout attempts", () => {
  it("records the tier with a fresh attempt and reuses a bound one", async () => {
    const now = new Date("2026-09-07T00:00:00.000Z");
    const upsert = vi.fn().mockImplementation(async ({ create }: any) => ({ ...create }));
    const transaction = {
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      subscriptionCheckoutAttempt: { findUnique: vi.fn().mockResolvedValue(null), upsert },
    };
    const created = await getOrCreateSubscriptionCheckoutAttempt({
      userId: "user-1",
      planId: "storage",
      billingOfferId: "offer-200",
      tier: "200gb",
      now,
      customerId: "cus_1",
      expiresAt: new Date("2026-09-08T00:00:00.000Z"),
      prisma: transaction as never,
    });
    expect(created).toMatchObject({ tier: "200gb", billingOfferId: "offer-200" });
    expect(upsert.mock.calls[0][0].update).toMatchObject({ tier: "200gb" });

    const bound = {
      userId: "user-1",
      checkoutKey: "attempt-old",
      billingOfferId: "offer-100",
      tier: "100gb",
      stripeCheckoutSessionId: "cs_open",
      expiresAt: new Date("2026-09-06T00:00:00.000Z"),
    };
    transaction.subscriptionCheckoutAttempt.findUnique.mockResolvedValue(bound);
    upsert.mockClear();
    await expect(
      getOrCreateSubscriptionCheckoutAttempt({
        userId: "user-1",
        planId: "storage",
        billingOfferId: "offer-200",
        tier: "200gb",
        now,
        customerId: "cus_1",
        expiresAt: new Date("2026-09-08T00:00:00.000Z"),
        prisma: transaction as never,
      }),
    ).resolves.toBe(bound);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("schedules a storage cleanup when a bind loses to account deletion", async () => {
    const created: unknown[] = [];
    const transaction = {
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue({ userId: "user-1" }) },
      subscriptionCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "user-1",
          checkoutKey: "attempt-1",
          billingOfferId: "offer-100",
          tier: "100gb",
          stripeCheckoutSessionId: null,
          customerId: "cus_1",
          accountDeletionAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      customer: { findUnique: vi.fn() },
      stripeCheckoutCleanup: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    };
    await expect(
      bindSubscriptionCheckoutSession({
        userId: "user-1",
        planId: "storage",
        checkoutKey: "attempt-1",
        stripeCheckoutSessionId: "cs_1",
        expiresAt: new Date("2026-09-08T00:00:00.000Z"),
        prisma: transaction as never,
      }),
    ).resolves.toBe("account-deletion-authorized");
    expect(created).toEqual([
      expect.objectContaining({ kind: "storage", sessionId: "cs_1", billingOfferId: "offer-100" }),
    ]);
  });

  it("deletes only the attempt bound to the named session", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(
      deleteSubscriptionCheckoutAttempt({
        userId: "user-1",
        stripeCheckoutSessionId: "cs_other",
        prisma: { subscriptionCheckoutAttempt: { deleteMany } } as never,
      }),
    ).resolves.toBe(false);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", stripeCheckoutSessionId: "cs_other" } });
  });
});
