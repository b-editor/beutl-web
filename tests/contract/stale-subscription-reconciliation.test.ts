import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  getSubscriptionPeriod,
  isTerminalStatus,
  needsRepair,
  repairSubscriptions,
} from "../../apps/web/scripts/reconcile-stale-subscriptions.mjs";

function stripeSubscription(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "sub_1",
    status,
    items: { data: [{ current_period_start: 100, current_period_end: 200 }] },
    ...overrides,
  };
}

describe("stale subscription reconciliation", () => {
  it("repairs a local row that Stripe already terminated", () => {
    expect(
      needsRepair({ status: "active" }, stripeSubscription("canceled")),
    ).toBe(true);
    expect(
      needsRepair({ status: "past_due" }, stripeSubscription("incomplete_expired")),
    ).toBe(true);
  });

  it("leaves rows alone when Stripe still reports a live subscription", () => {
    expect(needsRepair({ status: "active" }, stripeSubscription("active"))).toBe(
      false,
    );
    expect(
      needsRepair({ status: "active" }, stripeSubscription("past_due")),
    ).toBe(false);
  });

  it("does not rewrite a row that is already terminal", () => {
    expect(
      needsRepair({ status: "canceled" }, stripeSubscription("canceled")),
    ).toBe(false);
  });

  it("classifies only canceled and incomplete_expired as terminal", () => {
    expect(isTerminalStatus("canceled")).toBe(true);
    expect(isTerminalStatus("incomplete_expired")).toBe(true);
    expect(isTerminalStatus("unpaid")).toBe(false);
    expect(isTerminalStatus("paused")).toBe(false);
  });

  it("reads the billing period from the subscription item first", () => {
    expect(getSubscriptionPeriod(stripeSubscription("canceled"))).toEqual({
      currentPeriodStart: new Date(100_000),
      currentPeriodEnd: new Date(200_000),
    });

    // Older API versions carry the period on the subscription itself.
    expect(
      getSubscriptionPeriod({
        id: "sub_legacy",
        status: "canceled",
        items: { data: [] },
        current_period_start: 300,
        current_period_end: 400,
      }),
    ).toEqual({
      currentPeriodStart: new Date(300_000),
      currentPeriodEnd: new Date(400_000),
    });
  });

  it("repairs a stale storage subscription row keyed by its plan", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        { userId: "user-1", planId: "storage", stripeSubscriptionId: "sub_storage", status: "active" },
      ])
      .mockResolvedValueOnce([]);
    const prisma = {
      subscription: { findMany, updateMany },
      subscriptionCheckoutAttempt: { deleteMany },
    };
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(stripeSubscription("canceled", { id: "sub_storage" })),
      },
    };

    const result = await repairSubscriptions(prisma, stripe, { apply: true });

    expect(result).toEqual({ inspected: 1, repaired: 1 });
    // Pages walk the (userId, planId) key so a user holding several plans is
    // never skipped past.
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ orderBy: [{ userId: "asc" }, { planId: "asc" }] }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { userId: { gt: "user-1" } },
            { userId: "user-1", planId: { gt: "storage" } },
          ],
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", planId: "storage", stripeSubscriptionId: "sub_storage" }),
        data: expect.objectContaining({ status: "canceled" }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", planId: "storage" } });
  });
});
