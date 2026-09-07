import { beforeEach, describe, expect, it } from "vitest";
import { countActiveSubscriptions, setDbProvider } from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const NOW = new Date("2026-09-07T00:00:00.000Z");
const FUTURE = new Date("2026-10-01T00:00:00.000Z");
const PAST = new Date("2026-08-01T00:00:00.000Z");

describe("active subscriptions counted per plan and tier", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function row(userId: string, tier: string, overrides: Record<string, unknown> = {}) {
    memory.state.subscriptions.set(`${userId}:storage`, {
      userId,
      stripeSubscriptionId: `sub_${userId}`,
      status: "active",
      planId: "storage",
      tier: tier,
      billingOfferId: `offer_${tier}`,
      currentPeriodStart: PAST,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: PAST,
      updatedAt: PAST,
      ...overrides,
    });
  }

  it("returns zero when nobody subscribes", async () => {
    await expect(
      countActiveSubscriptions({ now: NOW, planId: "storage" }),
    ).resolves.toEqual({ total: 0, byTier: {} });
  });

  it("counts only rows that currently grant a tier", async () => {
    row("a", "100gb");
    row("b", "100gb");
    row("c", "1tb");
    row("lapsed", "200gb", { currentPeriodEnd: PAST });
    row("canceled", "200gb", { status: "canceled" });
    row("unpriced", "200gb", { billingOfferId: null });
    row("cancelled-early", "200gb", { cancelAt: PAST });
    row("unknown-tier", "5tb");
    // A Pro row is another plan and never lands in the storage count.
    memory.state.subscriptions.set("pro-user:pro", {
      userId: "pro-user",
      stripeSubscriptionId: "sub_pro",
      status: "active",
      planId: "pro",
      tier: null,
      billingOfferId: "offer_pro",
      currentPeriodStart: PAST,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: PAST,
      updatedAt: PAST,
    });

    // A live subscription on a tier this build does not know is still a
    // subscription: it counts toward the total under its own tier id.
    await expect(
      countActiveSubscriptions({ now: NOW, planId: "storage" }),
    ).resolves.toEqual({ total: 4, byTier: { "100gb": 2, "1tb": 1, "5tb": 1 } });
    await expect(
      countActiveSubscriptions({ now: NOW, planId: "pro" }),
    ).resolves.toEqual({ total: 1, byTier: {} });
  });

  it("excludes accounts with an active hold on the storage subscription or a deletion in progress", async () => {
    row("held", "100gb");
    row("pro-held", "100gb");
    row("deleting", "1tb");
    row("kept", "1tb");
    const prisma = {
      ...memory.prisma,
      subscriptionEntitlementHold: {
        findMany: async () => [
          // A hold on this user's storage subscription: excluded.
          { userId: "held", stripeSubscriptionId: "sub_held", billingPeriodStart: PAST, billingPeriodEnd: FUTURE },
          // A hold on some other subscription (the Pro one): not excluded.
          { userId: "pro-held", stripeSubscriptionId: "sub_pro", billingPeriodStart: PAST, billingPeriodEnd: FUTURE },
        ],
      },
      accountDeletionIntent: {
        findMany: async () => [{ userId: "deleting" }],
      },
    };

    await expect(
      countActiveSubscriptions({ now: NOW, planId: "storage", prisma: prisma as never }),
    ).resolves.toEqual({ total: 2, byTier: { "100gb": 1, "1tb": 1 } });
  });
});
