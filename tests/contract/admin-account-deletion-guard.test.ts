import { describe, expect, it, vi } from "vitest";
import { reserveAdminAccountDeletion } from "../../packages/db/src/account-deletion";

function transaction(overrides: {
  subscription?: { status: string } | null;
  checkout?: { stripeCheckoutSessionId: string | null } | null;
  customer?: { userId: string } | null;
  customerStripeId?: string | null;
  activeIntent?: { identifier: string; tokenHash: string } | null;
  provisioningCount?: number;
  blockerCount?: number;
} = {}) {
  return {
    accountDeletionIntent: {
      findFirst: vi.fn().mockResolvedValue(overrides.activeIntent ?? null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    stripeCustomerProvisioning: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(overrides.provisioningCount ?? 0),
    },
    subscription: {
      findUnique: vi.fn().mockResolvedValue(overrides.subscription ?? null),
    },
    proCheckoutAttempt: {
      findUnique: vi.fn().mockResolvedValue(overrides.checkout ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(overrides.blockerCount ?? 0),
    },
    packageCheckoutAttempt: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    stripeCheckoutCleanup: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    },
    package: { findMany: vi.fn().mockResolvedValue([]) },
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
    aiRemoteJobCleanup: { upsert: vi.fn().mockResolvedValue(undefined) },
    customer: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.customer
          ? { ...overrides.customer, stripeId: overrides.customerStripeId ?? "cus_1" }
          : null,
      ),
    },
  };
}

describe("administrator account deletion guard", () => {
  it("reserves before the billing preflight, closing the mapping/bind race", async () => {
    const tx = transaction();
    const result = await reserveAdminAccountDeletion({
      userId: "user-1",
      now: new Date("2026-08-25T00:00:00.000Z"),
      prisma: tx as never,
    });

    expect(result).toEqual({ status: "reserved" });
    expect(tx.accountDeletionIntent.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["subscription", { subscription: { status: "past_due" } }],
  ] as const)("blocks an active subscription", async (reason, state) => {
    const tx = transaction(state);
    await expect(
      reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never }),
    ).resolves.toEqual({ status: "blocked", reason });
    expect(tx.accountDeletionIntent.delete).not.toHaveBeenCalled();
  });

  it("blocks an unbound active checkout before allowing deletion", async () => {
    const tx = transaction({ blockerCount: 1 });
    await expect(reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never })).resolves.toEqual({ status: "blocked", reason: "checkout" });
  });

  it("blocks while Stripe customer provisioning is pending", async () => {
    const tx = transaction({ provisioningCount: 1 });
    await expect(reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never })).resolves.toEqual({ status: "blocked", reason: "provisioning" });
  });

  it("keeps a provisioning intervention fenced while blocking deletion", async () => {
    const tx = transaction({ provisioningCount: 1 });

    await expect(
      reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never }),
    ).resolves.toEqual({ status: "blocked", reason: "provisioning" });
    expect(tx.stripeCustomerProvisioning.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: {
          in: ["pending", "mapping", "cleanup_required"],
        },
      },
      data: {
        status: "cleanup_required",
        notBefore: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(tx.stripeCustomerProvisioning.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: {
          in: ["pending", "mapping", "cleanup_required", "intervention"],
        },
      },
    });
  });

  it("rechecks blockers when an active deletion intent is resumed", async () => {
    const tx = transaction({ activeIntent: { identifier: "intent", tokenHash: "hash" }, blockerCount: 1 });
    await expect(reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never })).resolves.toEqual({ status: "blocked", reason: "checkout" });
    expect(tx.accountDeletionIntent.upsert).not.toHaveBeenCalled();
  });

  it("snapshots an existing Customer while retaining the durable intent", async () => {
    const tx = transaction({ customer: { userId: "user-1" }, customerStripeId: "cus_42" });
    const result = await reserveAdminAccountDeletion({ userId: "user-1", prisma: tx as never });
    expect(result).toEqual({ status: "reserved" });
    expect(tx.accountDeletionIntent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ stripeCustomerId: "cus_42" }),
    }));
    expect(tx.accountDeletionIntent.delete).not.toHaveBeenCalled();
  });
});
