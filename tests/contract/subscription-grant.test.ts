import { beforeEach, describe, expect, it } from "vitest";
import {
  addUtcMonths,
  isActiveSubscription,
  STORAGE_FREE_QUOTA_BYTES,
  subscriptionGrantPeriodAt,
  subscriptionGrantStatus,
  subscriptionStateOfGrant,
} from "@beutl/core";
import {
  consumeUsage,
  createSubscriptionGrant,
  getEntitlementSubscription,
  listSubscriptionGrantsByUserId,
  resolveStorageQuota,
  revokeSubscriptionGrant,
  setDbProvider,
  startRetryableTransaction,
} from "@beutl/db";
import { getEntitlementSummary } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "grant-user";
const ADMIN_ID = "admin-1";
const DAY = 24 * 60 * 60 * 1_000;

describe("subscription grant periods", () => {
  const grant = (startsAt: string, endsAt: string | null = null) => ({
    startsAt: new Date(startsAt),
    endsAt: endsAt === null ? null : new Date(endsAt),
    revokedAt: null,
  });

  it("renews the allowance monthly from the day the grant started", () => {
    const term = grant("2026-01-15T09:30:00.000Z");
    expect(
      subscriptionGrantPeriodAt(term, new Date("2026-03-20T00:00:00.000Z")),
    ).toEqual({
      start: new Date("2026-03-15T09:30:00.000Z"),
      end: new Date("2026-04-15T09:30:00.000Z"),
    });
    // Before the anchor time on the anchor day, the previous period still runs.
    expect(
      subscriptionGrantPeriodAt(term, new Date("2026-03-15T09:29:59.999Z")),
    ).toEqual({
      start: new Date("2026-02-15T09:30:00.000Z"),
      end: new Date("2026-03-15T09:30:00.000Z"),
    });
  });

  it("clamps to the end of a short month and returns to the anchor day", () => {
    const term = grant("2026-01-31T00:00:00.000Z");
    expect(
      subscriptionGrantPeriodAt(term, new Date("2026-03-01T00:00:00.000Z")),
    ).toEqual({
      start: new Date("2026-02-28T00:00:00.000Z"),
      end: new Date("2026-03-31T00:00:00.000Z"),
    });
    expect(addUtcMonths(new Date("2028-01-31T00:00:00.000Z"), 1)).toEqual(
      new Date("2028-02-29T00:00:00.000Z"),
    );
  });

  it("cuts the last period at the end of the grant", () => {
    const term = grant("2026-01-15T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    expect(
      subscriptionGrantPeriodAt(term, new Date("2026-02-20T00:00:00.000Z")),
    ).toEqual({
      start: new Date("2026-02-15T00:00:00.000Z"),
      end: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(
      subscriptionGrantPeriodAt(term, new Date("2026-03-01T00:00:00.000Z")),
    ).toBeNull();
  });

  it("is in effect neither before it starts nor after it is revoked", () => {
    expect(
      subscriptionGrantPeriodAt(
        grant("2026-05-01T00:00:00.000Z"),
        new Date("2026-04-30T00:00:00.000Z"),
      ),
    ).toBeNull();
    expect(
      subscriptionGrantPeriodAt(
        {
          ...grant("2026-05-01T00:00:00.000Z"),
          revokedAt: new Date("2026-05-02T00:00:00.000Z"),
        },
        new Date("2026-05-10T00:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("reports a grant that has not started as scheduled, not active", () => {
    const term = grant("2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    expect(subscriptionGrantStatus(term, new Date("2026-04-30T00:00:00.000Z"))).toBe(
      "scheduled",
    );
    expect(subscriptionGrantStatus(term, new Date("2026-05-01T00:00:00.000Z"))).toBe(
      "active",
    );
    expect(subscriptionGrantStatus(term, new Date("2026-06-01T00:00:00.000Z"))).toBe(
      "expired",
    );
  });

  it("entitles through the shared rule without a Stripe Price", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const state = subscriptionStateOfGrant(
      {
        id: "grant-1",
        planId: "storage",
        tier: "1tb",
        ...grant("2026-05-01T00:00:00.000Z", "2026-05-20T00:00:00.000Z"),
      },
      now,
    );
    expect(state).toMatchObject({
      source: "grant",
      status: "active",
      billingOfferId: null,
      // The grant ends inside this period, so the period end is where it stops.
      cancelAtPeriodEnd: true,
    });
    expect(isActiveSubscription(state, "storage", now)).toBe(true);
    expect(isActiveSubscription(state, "pro", now)).toBe(false);
    // A Stripe row without a known Price still grants nothing.
    expect(
      isActiveSubscription(
        { ...state!, source: undefined },
        "storage",
        now,
      ),
    ).toBe(false);
  });
});

describe("subscription grants", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    memory.state.users.add(USER_ID);
    setDbProvider(async () => memory.prisma as never);
  });

  function storeSubscription(
    planId: "pro" | "storage",
    overrides: Record<string, unknown> = {},
  ) {
    memory.state.subscriptions.set(`${USER_ID}:${planId}`, {
      userId: USER_ID,
      stripeSubscriptionId: `sub_${planId}`,
      status: "active",
      planId,
      tier: planId === "storage" ? "100gb" : null,
      billingOfferId: `offer_${planId}`,
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 29 * DAY),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  async function grant({
    planId = "pro",
    tier = null,
    startsAt = new Date(),
    endsAt = null,
    userId = USER_ID,
  }: {
    planId?: string;
    tier?: string | null;
    startsAt?: Date;
    endsAt?: Date | null;
    userId?: string;
  } = {}) {
    return await startRetryableTransaction(
      async (tx) =>
        await createSubscriptionGrant({
          userId,
          planId,
          tier,
          startsAt,
          endsAt,
          reason: "Beta tester",
          grantedByUserId: ADMIN_ID,
          prisma: tx,
        }),
    );
  }

  it("records who granted what and for how long", async () => {
    const endsAt = new Date(Date.now() + 30 * DAY);
    const result = await grant({ planId: "storage", tier: "1tb", endsAt });

    expect(result).toMatchObject({
      status: "created",
      grant: {
        userId: USER_ID,
        planId: "storage",
        tier: "1tb",
        endsAt,
        reason: "Beta tester",
        grantedByUserId: ADMIN_ID,
        revokedAt: null,
      },
    });
    expect(memory.state.subscriptionGrants.size).toBe(1);
  });

  it("refuses a tier the plan does not have and a period that ends at once", async () => {
    await expect(grant({ planId: "storage", tier: null })).resolves.toEqual({
      status: "rejected",
      reason: "invalid-tier",
    });
    await expect(grant({ planId: "pro", tier: "1tb" })).resolves.toEqual({
      status: "rejected",
      reason: "invalid-tier",
    });
    await expect(grant({ planId: "enterprise" })).resolves.toEqual({
      status: "rejected",
      reason: "invalid-plan",
    });
    const startsAt = new Date();
    await expect(grant({ startsAt, endsAt: startsAt })).resolves.toEqual({
      status: "rejected",
      reason: "invalid-term",
    });
    await expect(grant({ userId: "missing-user" })).resolves.toEqual({
      status: "rejected",
      reason: "user-not-found",
    });
    expect(memory.state.subscriptionGrants.size).toBe(0);
  });

  it("keeps one grant in effect per plan", async () => {
    await grant();
    await expect(grant()).resolves.toEqual({
      status: "rejected",
      reason: "grant-exists",
    });
    // Another plan is a separate entitlement.
    await expect(grant({ planId: "storage", tier: "100gb" })).resolves.toMatchObject({
      status: "created",
    });
  });

  it("does not grant a plan the user still has a Stripe subscription for", async () => {
    storeSubscription("pro");
    await expect(grant()).resolves.toEqual({
      status: "rejected",
      reason: "subscription-open",
    });
    // A failed payment still leaves the subscription to be fixed or canceled.
    storeSubscription("pro", { status: "past_due" });
    await expect(grant()).resolves.toEqual({
      status: "rejected",
      reason: "subscription-open",
    });
    // Once it is over, a grant can take its place.
    storeSubscription("pro", {
      cancelAtPeriodEnd: true,
      cancelAt: new Date(Date.now() - 1_000),
    });
    await expect(grant()).resolves.toMatchObject({ status: "created" });
  });

  it("allows a new grant after the previous one is revoked or has ended", async () => {
    const first = await grant();
    if (first.status !== "created") throw new Error("not created");
    const revoked = await startRetryableTransaction(
      async (tx) =>
        await revokeSubscriptionGrant({
          grantId: first.grant.id,
          userId: USER_ID,
          revokedByUserId: ADMIN_ID,
          prisma: tx,
        }),
    );
    expect(revoked?.id).toBe(first.grant.id);
    expect(memory.state.subscriptionGrants.get(first.grant.id)).toMatchObject({
      revokedByUserId: ADMIN_ID,
    });
    // A second revoke does not rewrite the history.
    await expect(
      startRetryableTransaction(
        async (tx) =>
          await revokeSubscriptionGrant({
            grantId: first.grant.id,
            userId: USER_ID,
            revokedByUserId: "admin-2",
            prisma: tx,
          }),
      ),
    ).resolves.toBeNull();

    await expect(grant()).resolves.toMatchObject({ status: "created" });
  });

  it("does not count a grant that has already ended", async () => {
    const ended = await grant({
      startsAt: new Date(Date.now() - 40 * DAY),
      endsAt: new Date(Date.now() - DAY),
    });
    if (ended.status !== "created") throw new Error("not created");
    await expect(
      getEntitlementSubscription({ userId: USER_ID, planId: "pro" }),
    ).resolves.toBeNull();
    // Nothing is left to revoke, and a new grant may start.
    await expect(
      startRetryableTransaction(
        async (tx) =>
          await revokeSubscriptionGrant({
            grantId: ended.grant.id,
            userId: USER_ID,
            revokedByUserId: ADMIN_ID,
            prisma: tx,
          }),
      ),
    ).resolves.toBeNull();
    await expect(grant()).resolves.toMatchObject({ status: "created" });
  });

  it("counts a grant that has not started yet as one in effect", async () => {
    await grant({
      startsAt: new Date(Date.now() + 10 * DAY),
      endsAt: new Date(Date.now() + 40 * DAY),
    });
    // Not entitling yet, but a new grant would overlap it.
    await expect(
      getEntitlementSubscription({ userId: USER_ID, planId: "pro" }),
    ).resolves.toBeNull();
    await expect(grant()).resolves.toEqual({
      status: "rejected",
      reason: "grant-exists",
    });
  });

  it("lists every grant still in effect beyond the history limit", async () => {
    const at = (days: number) => new Date(Date.now() + days * DAY);
    const row = (id: string, createdAt: Date, overrides: Record<string, unknown>) => ({
      id,
      userId: USER_ID,
      planId: "storage",
      tier: "100gb",
      startsAt: createdAt,
      endsAt: null,
      reason: "r",
      grantedByUserId: ADMIN_ID,
      revokedAt: null,
      revokedByUserId: null,
      createdAt,
      updatedAt: createdAt,
      ...overrides,
    });
    // The oldest grant is still in effect; newer ones were granted and revoked.
    memory.state.subscriptionGrants.set(
      "old-pro",
      row("old-pro", at(-30), { planId: "pro", tier: null }),
    );
    for (const day of [-3, -2, -1]) {
      const id = `revoked-${day}`;
      memory.state.subscriptionGrants.set(
        id,
        row(id, at(day), { revokedAt: at(day), revokedByUserId: ADMIN_ID }),
      );
    }

    const grants = await listSubscriptionGrantsByUserId({ userId: USER_ID, limit: 2 });
    expect(grants.map((item) => item.id)).toEqual([
      "revoked--1",
      "revoked--2",
      "old-pro",
    ]);
  });

  it("refuses to revoke another user's grant", async () => {
    const created = await grant();
    if (created.status !== "created") throw new Error("not created");
    await expect(
      startRetryableTransaction(
        async (tx) =>
          await revokeSubscriptionGrant({
            grantId: created.grant.id,
            userId: "someone-else",
            revokedByUserId: ADMIN_ID,
            prisma: tx,
          }),
      ),
    ).resolves.toBeNull();
  });

  describe("entitlement", () => {
    it("prefers an active Stripe subscription over a grant", async () => {
      await grant({ planId: "storage", tier: "1tb" });
      storeSubscription("storage");

      const subscription = await getEntitlementSubscription({
        userId: USER_ID,
        planId: "storage",
      });
      expect(subscription?.source).toBe("stripe");
      await expect(resolveStorageQuota({ userId: USER_ID })).resolves.toMatchObject({
        tier: "100gb",
      });
    });

    it("falls back to the grant while the Stripe subscription grants nothing", async () => {
      await grant({ planId: "storage", tier: "1tb" });
      storeSubscription("storage", { status: "past_due" });

      const quota = await resolveStorageQuota({ userId: USER_ID });
      expect(quota.tier).toBe("1tb");
      expect(quota.subscription).toMatchObject({ source: "grant", tier: "1tb" });
    });

    it("returns the Stripe row for display when no grant is in effect", async () => {
      storeSubscription("pro", { status: "canceled" });
      await expect(
        getEntitlementSubscription({ userId: USER_ID, planId: "pro" }),
      ).resolves.toMatchObject({ source: "stripe", status: "canceled" });
      await expect(
        getEntitlementSubscription({ userId: "nobody", planId: "pro" }),
      ).resolves.toBeNull();
    });

    it("gives the storage tier until the grant is revoked", async () => {
      const created = await grant({ planId: "storage", tier: "200gb" });
      if (created.status !== "created") throw new Error("not created");
      await expect(resolveStorageQuota({ userId: USER_ID })).resolves.toMatchObject({
        tier: "200gb",
      });

      await startRetryableTransaction(
        async (tx) =>
          await revokeSubscriptionGrant({
            grantId: created.grant.id,
            userId: USER_ID,
            revokedByUserId: ADMIN_ID,
            prisma: tx,
          }),
      );
      await expect(resolveStorageQuota({ userId: USER_ID })).resolves.toMatchObject({
        tier: null,
        quotaBytes: STORAGE_FREE_QUOTA_BYTES,
      });
    });

    it("stops at the end of the grant", async () => {
      await grant({
        planId: "storage",
        tier: "1tb",
        startsAt: new Date(Date.now() - 10 * DAY),
        endsAt: new Date(Date.now() + DAY),
      });
      await expect(
        resolveStorageQuota({ userId: USER_ID, now: new Date(Date.now() + 2 * DAY) }),
      ).resolves.toMatchObject({ tier: null });
    });

    it("reports AI Pro from a grant, with its allowance period", async () => {
      const startsAt = new Date(Date.now() - 3 * DAY);
      const endsAt = new Date(Date.now() + 90 * DAY);
      await grant({ startsAt, endsAt });

      const summary = await getEntitlementSummary(USER_ID);
      expect(summary).toMatchObject({
        plan: "pro",
        canUseAi: true,
        subscriptionStatus: "active",
        currentPeriodStart: startsAt.toISOString(),
        currentPeriodEnd: addUtcMonths(startsAt, 1).toISOString(),
        cancelAtPeriodEnd: false,
        grant: { endsAt: endsAt.toISOString() },
      });

      // Usage recorded against the grant's period counts toward this month.
      await consumeUsage({
        userId: USER_ID,
        amount: 50,
        monthlyUsageLimit: 500,
        usagePeriod: { start: startsAt, end: addUtcMonths(startsAt, 1) },
        aiJobId: "job-granted",
      });
      const after = await getEntitlementSummary(USER_ID);
      expect(after.balance.monthlyUsage.usedPercent).toBeGreaterThan(0);
    });

    it("reports no plan once an indefinite grant is revoked", async () => {
      const created = await grant();
      if (created.status !== "created") throw new Error("not created");
      await expect(getEntitlementSummary(USER_ID)).resolves.toMatchObject({
        plan: "pro",
        grant: { endsAt: null },
      });

      await startRetryableTransaction(
        async (tx) =>
          await revokeSubscriptionGrant({
            grantId: created.grant.id,
            userId: USER_ID,
            revokedByUserId: ADMIN_ID,
            prisma: tx,
          }),
      );
      await expect(getEntitlementSummary(USER_ID)).resolves.toMatchObject({
        plan: null,
        canUseAi: false,
        grant: null,
      });
    });
  });
});
