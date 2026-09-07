import { beforeEach, describe, expect, it } from "vitest";
import {
  compareSubscriptionObservation,
  createSubscriptionObservationRank,
  getSubscription,
  reconcileSubscriptionObservation,
  setDbProvider,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "observation-user";

function observation(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    stripeSubscriptionId: "sub_storage",
    status: "active",
    planId: "storage",
    tier: "100gb" as const,
    billingOfferId: "offer_100",
    currentPeriodStart: new Date(100_000),
    currentPeriodEnd: new Date(200_000),
    cancelAtPeriodEnd: false,
    cancelAt: null,
    stripeSubscriptionCreatedAt: new Date(50_000),
    stripeEventId: "evt_1",
    stripeEventCreatedAt: new Date(60_000),
    stripeCanonicalObservedAt: new Date(60_500),
    ...overrides,
  };
}

describe("subscription observations for a tiered plan", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  it("creates the row and records the tier", async () => {
    const result = await reconcileSubscriptionObservation(observation() as never);
    // Creation reports the row; `applied` is reserved for updates that beat
    // the stored watermark, exactly as for the Pro table.
    expect(result.subscription?.stripeSubscriptionId).toBe("sub_storage");
    const stored = await getSubscription({ userId: USER_ID, planId: "storage" });
    expect(stored).toMatchObject({
      stripeSubscriptionId: "sub_storage",
      tier: "100gb",
      planId: "storage",
      entitlementHeld: false,
    });
    // The Pro row of the same user is untouched: plans are separate rows.
    expect(memory.state.subscriptions.has(`${USER_ID}:pro`)).toBe(false);
    expect(memory.state.subscriptions.size).toBe(1);
  });

  it("ignores an older event and accepts a newer tier change", async () => {
    await reconcileSubscriptionObservation(observation() as never);
    const older = await reconcileSubscriptionObservation(
      observation({ tier: "1tb", stripeEventId: "evt_0", stripeEventCreatedAt: new Date(59_000), stripeCanonicalObservedAt: new Date(59_500) }) as never,
    );
    expect(older.applied).toBe(false);
    const newer = await reconcileSubscriptionObservation(
      observation({ tier: "1tb", billingOfferId: "offer_1tb", stripeEventId: "evt_2", stripeEventCreatedAt: new Date(61_000), stripeCanonicalObservedAt: new Date(61_500) }) as never,
    );
    expect(newer.applied).toBe(true);
    expect(memory.state.subscriptions.get(`${USER_ID}:storage`)?.tier).toBe("1tb");
  });

  it("keeps a terminal status over a later reversible one for the same subscription", async () => {
    await reconcileSubscriptionObservation(
      observation({ status: "canceled", stripeEventId: "evt_cancel", stripeEventCreatedAt: new Date(70_000) }) as never,
    );
    const revived = await reconcileSubscriptionObservation(
      observation({ status: "active", stripeEventId: "evt_late", stripeEventCreatedAt: new Date(80_000), stripeCanonicalObservedAt: new Date(80_500) }) as never,
    );
    expect(revived.applied).toBe(false);
    expect(memory.state.subscriptions.get(`${USER_ID}:storage`)?.status).toBe("canceled");
  });

  it("never swaps in another subscription when replacement is not allowed", async () => {
    await reconcileSubscriptionObservation(observation() as never);
    const result = await reconcileSubscriptionObservation(
      observation({ stripeSubscriptionId: "sub_other", stripeEventId: "evt_other", stripeEventCreatedAt: new Date(90_000), replaceExistingSubscription: false }) as never,
    );
    expect(result.applied).toBe(false);
    expect(memory.state.subscriptions.get(`${USER_ID}:storage`)?.stripeSubscriptionId).toBe("sub_storage");
    const missing = await reconcileSubscriptionObservation(
      observation({ userId: "nobody", replaceExistingSubscription: false }) as never,
    );
    expect(missing.applied).toBe(false);
    expect(memory.state.subscriptions.has("nobody:storage")).toBe(false);
  });

  it("rejects a tier the plan does not define", async () => {
    await expect(
      reconcileSubscriptionObservation(observation({ planId: "pro" }) as never),
    ).rejects.toThrow(RangeError);
    await expect(
      reconcileSubscriptionObservation(observation({ tier: "5tb" }) as never),
    ).rejects.toThrow(RangeError);
  });

  it("holds the storage entitlement only for a hold on the storage subscription", async () => {
    await reconcileSubscriptionObservation(observation() as never);
    const held = {
      ...memory.prisma,
      subscriptionEntitlementHold: {
        findFirst: async ({ where }: { where: { stripeSubscriptionId: string } }) =>
          where.stripeSubscriptionId === "sub_storage" ? { id: "hold" } : null,
      },
    };
    expect((await getSubscription({ userId: USER_ID, planId: "storage", prisma: held as never }))?.entitlementHeld).toBe(true);
    const proHeld = {
      ...memory.prisma,
      subscriptionEntitlementHold: {
        findFirst: async ({ where }: { where: { stripeSubscriptionId: string } }) =>
          where.stripeSubscriptionId === "sub_pro" ? { id: "hold" } : null,
      },
    };
    expect((await getSubscription({ userId: USER_ID, planId: "storage", prisma: proHeld as never }))?.entitlementHeld).toBe(false);
  });

  it("exposes the shared ordering helpers unchanged", () => {
    const rank = createSubscriptionObservationRank({
      stripeSubscriptionId: "sub_a",
      stripeSubscriptionCreatedAt: new Date(1_000),
      currentPeriodStart: new Date(2_000),
      currentPeriodEnd: new Date(3_000),
    });
    expect(rank).toBe("0000000000001000:0000000000002000:0000000000003000:sub_a");
    expect(
      compareSubscriptionObservation(
        { stripeEventCreatedAt: new Date(2), stripeCanonicalObservedAt: new Date(2), stripeEventId: "b", stripeObservationRank: rank, stripeSubscriptionId: "sub_a", status: "active" },
        { stripeEventCreatedAt: new Date(1), stripeCanonicalObservedAt: new Date(1), stripeEventId: "a", stripeObservationRank: rank, stripeSubscriptionId: "sub_a", status: "active" },
      ),
    ).toBeGreaterThan(0);
  });
});
