import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectAccountDeletionBillingBlockers,
  prepareAccountDeletionOutboxes,
  reserveAdminAccountDeletion,
} from "@beutl/db";
import { closeStripeCustomerForAdminAccountDeletion } from "@beutl/api";

const NOW = new Date("2026-09-07T00:00:00.000Z");

function fakeTransaction(overrides: {
  storageAttempt?: Record<string, unknown> | null;
  storageSubscription?: Record<string, unknown> | null;
  storageBlockers?: number;
} = {}) {
  const cleanups: unknown[] = [];
  const tx: Record<string, unknown> = {
    customer: { findUnique: vi.fn().mockResolvedValue({ stripeId: "cus_1" }) },
    subscriptionCheckoutAttempt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          overrides.storageAttempt
            ? [{ planId: "storage", ...overrides.storageAttempt }]
            : [],
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(overrides.storageBlockers ?? 0),
    },
    subscription: {
      findFirst: vi.fn(async ({ where }: { where?: { status?: { notIn?: string[] } } }) => {
        const stored = overrides.storageSubscription ?? null;
        if (!stored) return null;
        if (where?.status?.notIn?.includes(stored.status as string)) return null;
        return stored;
      }),
    },
    packageCheckoutAttempt: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    package: { findMany: vi.fn().mockResolvedValue([]) },
    stripeCheckoutCleanup: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: unknown }) => {
        cleanups.push(data);
        return data;
      }),
      update: vi.fn(),
    },
    stripeCustomerProvisioning: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    topUpCheckoutAttempt: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    topUpDuplicateRefundAttempt: { count: vi.fn().mockResolvedValue(0) },
    topUpCheckoutResolution: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    creditTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    aiJob: { findMany: vi.fn().mockResolvedValue([]) },
    aiRemoteJobCleanup: { upsert: vi.fn() },
    accountDeletionIntent: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  return { tx, cleanups };
}

describe("storage plan and account deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("freezes the bound storage attempt and schedules a storage cleanup", async () => {
    const { tx, cleanups } = fakeTransaction({
      storageAttempt: { stripeCheckoutSessionId: "cs_storage", billingOfferId: "offer_100gb", customerId: "cus_1" },
    });

    await prepareAccountDeletionOutboxes({ userId: "user-1", now: NOW, prisma: tx as never });

    expect(cleanups).toEqual([
      expect.objectContaining({ kind: "storage", sessionId: "cs_storage", billingOfferId: "offer_100gb", userId: "user-1" }),
    ]);
    expect((tx.subscriptionCheckoutAttempt as { updateMany: ReturnType<typeof vi.fn> }).updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { expiresAt: NOW, accountDeletionAt: NOW },
    });
  });

  it("counts an unresolved storage attempt as a deletion blocker", async () => {
    const { tx } = fakeTransaction({ storageBlockers: 1 });
    const blockers = await inspectAccountDeletionBillingBlockers({ userId: "user-1", prisma: tx as never });
    expect(blockers.subscriptionCheckout).toBe(1);
    expect(Object.values(blockers).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("blocks an administrator deletion while a storage subscription is live", async () => {
    const { tx } = fakeTransaction({ storageSubscription: { status: "active", planId: "storage" } });
    // The plan is named so the administrator is told to cancel the storage
    // subscription, not a Pro one the user may not have.
    await expect(
      reserveAdminAccountDeletion({ userId: "user-1", now: NOW, prisma: tx as never }),
    ).resolves.toEqual({ status: "blocked", reason: "subscription", planId: "storage" });

    const settled = fakeTransaction({ storageSubscription: { status: "canceled" } });
    await expect(
      reserveAdminAccountDeletion({ userId: "user-1", now: NOW, prisma: settled.tx as never }),
    ).resolves.toEqual({ status: "reserved" });
  });

  it("classifies a storage Checkout Session as storage cleanup during Stripe closure", async () => {
    const scheduled: unknown[] = [];
    const db = await import("@beutl/db");
    const schedule = vi
      .spyOn(db, "scheduleStripeCheckoutCleanup")
      .mockImplementation(async (args) => {
        scheduled.push(args);
        return {} as never;
      });
    const owner = { beutlApplication: "beutl-web", beutlUserId: "user-1" };
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: "cus_1", metadata: owner }),
        del: vi.fn().mockResolvedValue({ id: "cus_1", deleted: true }),
      },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: {
        sessions: {
          list: vi
            .fn()
            .mockResolvedValueOnce({
              data: [
                {
                  id: "cs_storage_open",
                  status: "open",
                  metadata: { ...owner, planId: "storage", billingOfferId: "offer_100gb", tier: "100gb" },
                },
              ],
              has_more: false,
            })
            .mockResolvedValue({ data: [], has_more: false }),
          expire: vi.fn().mockResolvedValue({ status: "expired" }),
          retrieve: vi.fn(),
        },
      },
      paymentIntents: { retrieve: vi.fn() },
      charges: { retrieve: vi.fn() },
    };

    const result = await closeStripeCustomerForAdminAccountDeletion({
      userId: "user-1",
      stripeCustomerId: "cus_1",
      deletionAuthorizedAt: NOW,
      secretKey: "sk_test",
      stripeClient: stripe as never,
    });

    expect(result.status).toBe("closed");
    expect(scheduled).toEqual([
      expect.objectContaining({ kind: "storage", sessionId: "cs_storage_open", billingOfferId: "offer_100gb" }),
    ]);
    schedule.mockRestore();
  });
});
