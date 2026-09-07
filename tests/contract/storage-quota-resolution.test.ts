import { beforeEach, describe, expect, it } from "vitest";
import { resolveStorageQuota, setDbProvider } from "@beutl/db";
import {
  STORAGE_FREE_FILE_COUNT_LIMIT,
  STORAGE_FREE_QUOTA_BYTES,
  STORAGE_PAID_FILE_COUNT_LIMIT,
} from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "quota-user";
const GIB = 1024 * 1024 * 1024;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
const PAST = new Date(Date.now() - 60 * 1_000);

describe("storage quota resolution", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function storeSubscription(overrides: Record<string, unknown> = {}) {
    memory.state.subscriptions.set(`${USER_ID}:storage`, {
      userId: USER_ID,
      stripeSubscriptionId: "sub_storage",
      status: "active",
      planId: "storage",
      tier: "100gb",
      billingOfferId: "offer_storage_100",
      currentPeriodStart: PAST,
      currentPeriodEnd: FUTURE,
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

  it("gives the free quota to an account without a row", async () => {
    await expect(resolveStorageQuota({ userId: USER_ID })).resolves.toEqual({
      tier: null,
      quotaBytes: STORAGE_FREE_QUOTA_BYTES,
      fileCountLimit: STORAGE_FREE_FILE_COUNT_LIMIT,
      subscription: null,
    });
  });

  it("gives the tier's quota to an active subscription", async () => {
    storeSubscription();
    const quota = await resolveStorageQuota({ userId: USER_ID });
    expect(quota.tier).toBe("100gb");
    expect(quota.quotaBytes).toBe(100 * GIB);
    expect(quota.fileCountLimit).toBe(STORAGE_PAID_FILE_COUNT_LIMIT);
    expect(quota.subscription?.stripeSubscriptionId).toBe("sub_storage");
  });

  it("falls back to free once the subscription lapses or is canceled", async () => {
    storeSubscription({ currentPeriodEnd: PAST });
    expect((await resolveStorageQuota({ userId: USER_ID })).tier).toBeNull();
    storeSubscription({ status: "canceled" });
    expect((await resolveStorageQuota({ userId: USER_ID })).tier).toBeNull();
    storeSubscription({ cancelAt: PAST });
    expect((await resolveStorageQuota({ userId: USER_ID })).tier).toBeNull();
  });

  it("uses the supplied client instead of the configured provider", async () => {
    storeSubscription();
    setDbProvider(async () => {
      throw new Error("the configured provider must not be used");
    });
    const quota = await resolveStorageQuota({
      userId: USER_ID,
      prisma: memory.prisma as never,
    });
    expect(quota.tier).toBe("100gb");
  });

  it("evaluates the period against the supplied clock", async () => {
    storeSubscription();
    const later = new Date(FUTURE.getTime() + 1_000);
    expect((await resolveStorageQuota({ userId: USER_ID, now: later })).tier).toBeNull();
  });
});
