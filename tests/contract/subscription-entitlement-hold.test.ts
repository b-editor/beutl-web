import { isActiveProSubscription } from "@beutl/api";
import {
  getSubscriptionByUserId,
  reconcileSubscriptionEntitlementHold,
  setDbProvider,
} from "@beutl/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const augustStart = new Date("2026-08-01T00:00:00.000Z");
const septemberStart = new Date("2026-09-01T00:00:00.000Z");
const octoberStart = new Date("2026-10-01T00:00:00.000Z");

describe("Pro entitlement reversal holds", () => {
  let hold: any = null;
  let currentSubscriptionId: string;
  let currentPeriodStart: Date;
  let currentPeriodEnd: Date;
  const subscription = {
    userId: "user-1",
    stripeSubscriptionId: "sub_1",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: augustStart,
    currentPeriodEnd: septemberStart,
    cancelAt: null,
    cancelAtPeriodEnd: false,
  };

  const common = (
    stripeReversalKind: "refund" | "dispute",
    stripeReversalId: string,
  ) => ({
    userId: "user-1",
    stripeSubscriptionId: "sub_1",
    stripePaymentIntentId: "pi_invoice_1",
    stripeReversalKind,
    stripeReversalId,
    stripeInvoiceId: "in_1",
    billingPeriodStart: augustStart,
    billingPeriodEnd: septemberStart,
    paymentAmount: 2_000,
    reversalAmount: 2_000,
    currency: "usd",
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    hold = null;
    currentSubscriptionId = "sub_1";
    currentPeriodStart = augustStart;
    currentPeriodEnd = septemberStart;
    const prisma: any = {
      subscription: {
        findUnique: async () => ({
          ...subscription,
          stripeSubscriptionId: currentSubscriptionId,
          currentPeriodStart,
          currentPeriodEnd,
        }),
      },
      subscriptionEntitlementHold: {
        findFirst: async ({ where }: any) => {
          if (
            !hold?.active ||
            hold.userId !== where.userId ||
            hold.stripeSubscriptionId !== where.stripeSubscriptionId
          ) {
            return null;
          }
          const startsBeforePeriodEnd =
            where.billingPeriodStart === undefined ||
            (hold.billingPeriodStart instanceof Date &&
              hold.billingPeriodStart < where.billingPeriodStart.lt);
          const endsAfterPeriodStart =
            where.billingPeriodEnd === undefined ||
            (hold.billingPeriodEnd instanceof Date &&
              hold.billingPeriodEnd > where.billingPeriodEnd.gt);
          const overlaps = startsBeforePeriodEnd && endsAfterPeriodStart;
          return overlaps ? { id: hold.id } : null;
        },
        upsert: async ({ create }: any) => {
          if (!hold) hold = { id: "hold-1", ...create };
          return { ...hold };
        },
        updateMany: async ({ where, data }: any) => {
          if (!hold) return { count: 0 };
          if (typeof where.id === "object") {
            return { count: 0 };
          }
          if (
            hold.id !== where.id ||
            hold.progressionRank !== where.progressionRank ||
            hold.stripeEventId !== where.stripeEventId ||
            hold.stripeEventCreatedAt.getTime() !==
              where.stripeEventCreatedAt.getTime() ||
            hold.stripeCanonicalObservedAt?.getTime() !==
              where.stripeCanonicalObservedAt?.getTime()
          ) {
            return { count: 0 };
          }
          hold = { ...hold, ...data };
          return { count: 1 };
        },
        findUnique: async () => (hold ? { ...hold } : null),
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback(prisma),
    };
    setDbProvider(async () => prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trust an active subscription without a verified billing offer", () => {
    expect(
      isActiveProSubscription({ ...subscription, billingOfferId: null }),
    ).toBe(false);
  });

  it("suspends access for a full dispute and restores it idempotently when won", async () => {
    const identity = common("dispute", "dp_1");
    await reconcileSubscriptionEntitlementHold({
      ...identity,
      status: "needs_response",
      active: true,
      stripeEventId: "evt_1",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    });
    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(false);

    const won = {
      ...identity,
      status: "won",
      active: false,
      stripeEventId: "evt_2",
      stripeEventCreatedAt: new Date("2026-08-11T00:01:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:01:01.000Z"),
    };
    await reconcileSubscriptionEntitlementHold(won);
    await reconcileSubscriptionEntitlementHold(won);
    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(true);

    await reconcileSubscriptionEntitlementHold({
      ...identity,
      status: "under_review",
      active: true,
      stripeEventId: "evt_late_delivery",
      stripeEventCreatedAt: new Date("2026-08-11T00:02:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:02:01.000Z"),
    });
    expect(hold).toMatchObject({ status: "won", active: false });
  });

  it("does not hold access for a partial refund", async () => {
    await reconcileSubscriptionEntitlementHold({
      ...common("refund", "re_partial"),
      reversalAmount: 400,
      status: "succeeded",
      active: false,
      stripeEventId: "evt_partial",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    });

    expect(hold).toMatchObject({ reversalAmount: 400, active: false });
    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(true);
  });

  it("limits a full reversal hold to the invoice billing period", async () => {
    await reconcileSubscriptionEntitlementHold({
      ...common("refund", "re_full"),
      status: "succeeded",
      active: true,
      stripeEventId: "evt_full",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    });
    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(false);

    // invoice.paid advances the locally persisted period. The old full refund
    // remains auditable but no longer blocks the newly paid period.
    currentPeriodStart = septemberStart;
    currentPeriodEnd = octoberStart;
    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(true);
  });

  it("does not let a null-period legacy hold block a bounded subscription", async () => {
    hold = {
      id: "hold-legacy",
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      active: true,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      paymentAmount: null,
      reversalAmount: null,
    };

    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(true);
  });

  it("does not carry an old subscription hold onto a replacement subscription", async () => {
    await reconcileSubscriptionEntitlementHold({
      ...common("dispute", "dp_1"),
      status: "under_review",
      active: true,
      stripeEventId: "evt_1",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    });
    currentSubscriptionId = "sub_2";

    expect(
      isActiveProSubscription(await getSubscriptionByUserId({ userId: "user-1" })),
    ).toBe(true);
  });

  it("clears an earlier invoice hold when one payment restoration makes the aggregate partial", async () => {
    let currentHold = {
      id: "hold-current",
      ...common("refund", "re_2"),
      stripePaymentIntentId: "pi_invoice_2",
      status: "pending",
      active: true,
      progressionRank: 10,
      stripeEventId: "evt_pending",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    };
    let earlierHold = {
      id: "hold-earlier",
      ...common("refund", "re_1"),
      stripePaymentIntentId: "pi_invoice_1",
      status: "succeeded",
      active: true,
      progressionRank: 100,
      stripeEventId: "evt_succeeded",
      stripeEventCreatedAt: new Date("2026-08-10T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-10T00:00:01.000Z"),
    };
    const updateMany = vi.fn(async ({ where, data }: any) => {
      if (where.id === currentHold.id) {
        currentHold = { ...currentHold, ...data };
        return { count: 1 };
      }
      if (
        where.id?.not === currentHold.id &&
        where.stripeInvoiceId === "in_1" &&
        earlierHold.active
      ) {
        earlierHold = { ...earlierHold, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    });
    const prisma: any = {
      subscriptionEntitlementHold: {
        upsert: async () => ({ ...currentHold }),
        findFirst: async () => ({ ...currentHold }),
        updateMany,
        findUnique: async () => ({ ...currentHold }),
      },
    };

    await reconcileSubscriptionEntitlementHold({
      ...common("refund", "re_2"),
      stripePaymentIntentId: "pi_invoice_2",
      reversalAmount: 1_000,
      status: "failed",
      active: false,
      stripeEventId: "evt_failed",
      stripeEventCreatedAt: new Date("2026-08-11T00:01:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:01:01.000Z"),
      prisma,
    });

    expect(currentHold.active).toBe(false);
    expect(earlierHold.active).toBe(false);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        userId: "user-1",
        stripeSubscriptionId: "sub_1",
        stripeInvoiceId: "in_1",
        id: { not: "hold-current" },
        active: true,
      },
      data: { active: false },
    });
  });

  it("does not let an older payment snapshot supersede a newer invoice restoration", async () => {
    let staleHold = {
      id: "hold-stale",
      ...common("refund", "re_stale"),
      stripePaymentIntentId: "pi_invoice_1",
      status: "succeeded",
      active: true,
      progressionRank: 100,
      stripeEventId: "evt_stale",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
    };
    const restoredHold = {
      id: "hold-restored",
      ...common("refund", "re_restored"),
      stripePaymentIntentId: "pi_invoice_2",
      reversalAmount: 1_000,
      status: "failed",
      active: false,
      progressionRank: 100,
      stripeEventId: "evt_restored",
      stripeEventCreatedAt: new Date("2026-08-11T00:01:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:01:01.000Z"),
    };
    const updateMany = vi.fn(async ({ where, data }: any) => {
      if (where.id === staleHold.id && where.active === true) {
        staleHold = { ...staleHold, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    });
    const prisma: any = {
      subscriptionEntitlementHold: {
        upsert: async () => ({ ...staleHold }),
        findFirst: async () => ({ ...restoredHold }),
        updateMany,
      },
    };

    const result = await reconcileSubscriptionEntitlementHold({
      ...common("refund", "re_stale"),
      stripePaymentIntentId: "pi_invoice_1",
      status: "succeeded",
      active: true,
      stripeEventId: "evt_stale",
      stripeEventCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-11T00:00:01.000Z"),
      prisma,
    });

    expect(result.applied).toBe(false);
    expect(staleHold.active).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
