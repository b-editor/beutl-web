import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  authorizeAccountDeletion: vi.fn(),
  closeStripeCustomerForAccountDeletion: vi.fn(),
  deleteUserById: vi.fn(),
  enqueueUserStorageCleanups: vi.fn(),
  findAccountDeletionIntent: vi.fn(),
  prepareAccountDeletionOutboxes: vi.fn(),
  startRetryableTransaction: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  deleteUserById: mocks.deleteUserById,
  enqueueUserStorageCleanups: mocks.enqueueUserStorageCleanups,
  findAccountDeletionIntent: mocks.findAccountDeletionIntent,
  prepareAccountDeletionOutboxes: mocks.prepareAccountDeletionOutboxes,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));
vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    account: { accountDeleted: "account.accountDeleted" },
  },
}));
vi.mock("@/lib/confirmation-token-flow", () => ({
  authorizeAccountDeletion: mocks.authorizeAccountDeletion,
}));
vi.mock("@/lib/customer", () => ({
  closeStripeCustomerForAccountDeletion:
    mocks.closeStripeCustomerForAccountDeletion,
}));

import { deleteUser } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/personal-data/handle/actions";

const intent = {
  authorizedAt: new Date("2026-08-09T00:00:00.000Z"),
  expiresAt: new Date("2026-08-16T00:00:00.000Z"),
  identifier: "owner@example.com",
  stripeCustomerId: "cus_1",
  tokenHash: "hashed-confirmation-token",
  userId: "user-1",
};

describe("resumable account deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeAccountDeletion.mockResolvedValue({
      status: "authorized",
      resumed: false,
      intent,
    });
    mocks.findAccountDeletionIntent.mockResolvedValue(intent);
    mocks.closeStripeCustomerForAccountDeletion.mockResolvedValue({
      status: "closed",
      customerId: "cus_1",
    });
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (prisma: object) => Promise<unknown>) =>
        await callback({ transaction: true }),
    );
    mocks.prepareAccountDeletionOutboxes.mockResolvedValue({ unboundCheckoutRecoveries: 0 });
  });

  it("durably authorizes before Stripe and deletes locally only after closure", async () => {
    await deleteUser("confirmation-token", "owner@example.com");

    expect(mocks.authorizeAccountDeletion).toHaveBeenCalledWith({
      token: "confirmation-token",
      identifier: "owner@example.com",
    });
    expect(mocks.closeStripeCustomerForAccountDeletion).toHaveBeenCalledWith({
      userId: "user-1",
      stripeCustomerId: "cus_1",
      deletionAuthorizedAt: intent.authorizedAt,
    });
    expect(
      mocks.authorizeAccountDeletion.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.closeStripeCustomerForAccountDeletion.mock.invocationCallOrder[0],
    );
    expect(
      mocks.closeStripeCustomerForAccountDeletion.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deleteUserById.mock.invocationCallOrder[0]);
    expect(mocks.enqueueUserStorageCleanups).toHaveBeenCalledWith({
      userId: "user-1",
      prisma: { transaction: true },
    });
    expect(mocks.prepareAccountDeletionOutboxes).toHaveBeenCalledWith({
      userId: "user-1",
      prisma: { transaction: true },
    });
    expect(
      mocks.prepareAccountDeletionOutboxes.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deleteUserById.mock.invocationCallOrder[0]);
    expect(mocks.deleteUserById).toHaveBeenCalledWith({
      userId: "user-1",
      prisma: { transaction: true },
    });
    expect(mocks.addAuditLog).toHaveBeenCalledWith({
      userId: null,
      action: "account.accountDeleted",
      details: "User user-1 deleted their account",
      prisma: { transaction: true },
    });
  });

  it("resumes the same authorized link after bound Checkout compensation persistence fails", async () => {
    mocks.closeStripeCustomerForAccountDeletion
      .mockRejectedValueOnce(
        new Error("Checkout compensation persistence unavailable"),
      )
      .mockResolvedValueOnce({ status: "already-closed", customerId: "cus_1" });

    await expect(
      deleteUser("confirmation-token", "owner@example.com"),
    ).rejects.toThrow("Checkout compensation persistence unavailable");
    expect(mocks.deleteUserById).not.toHaveBeenCalled();

    mocks.authorizeAccountDeletion.mockResolvedValueOnce({
      status: "authorized",
      resumed: true,
      intent,
    });
    await deleteUser("confirmation-token", "owner@example.com");

    expect(mocks.closeStripeCustomerForAccountDeletion).toHaveBeenCalledTimes(2);
    expect(mocks.deleteUserById).toHaveBeenCalledTimes(1);
  });

  it("keeps Stripe outside a retried final database transaction", async () => {
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (prisma: object) => Promise<unknown>) => {
        await callback({ transaction: true });
        return await callback({ transaction: true });
      },
    );

    await deleteUser("confirmation-token", "owner@example.com");

    expect(mocks.authorizeAccountDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.closeStripeCustomerForAccountDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.findAccountDeletionIntent).toHaveBeenCalledTimes(2);
    expect(mocks.prepareAccountDeletionOutboxes).toHaveBeenCalledTimes(2);
    expect(mocks.deleteUserById).toHaveBeenCalledTimes(2);
  });

  it("preserves the local user when Stripe customer ownership conflicts", async () => {
    mocks.closeStripeCustomerForAccountDeletion.mockResolvedValue({
      status: "owner-mismatch",
      customerId: "cus_other_owner",
    });

    await expect(
      deleteUser("confirmation-token", "owner@example.com"),
    ).rejects.toThrow("Stripe customer ownership could not be verified");
    expect(mocks.enqueueUserStorageCleanups).not.toHaveBeenCalled();
    expect(mocks.prepareAccountDeletionOutboxes).not.toHaveBeenCalled();
    expect(mocks.deleteUserById).not.toHaveBeenCalled();
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", "Invalid token"],
    ["expired", "Token has expired"],
  ] as const)("does not contact Stripe for an %s link", async (status, message) => {
    mocks.authorizeAccountDeletion.mockResolvedValue({ status });

    await expect(
      deleteUser("bad-token", "owner@example.com"),
    ).rejects.toThrow(message);
    expect(mocks.closeStripeCustomerForAccountDeletion).not.toHaveBeenCalled();
    expect(mocks.prepareAccountDeletionOutboxes).not.toHaveBeenCalled();
    expect(mocks.deleteUserById).not.toHaveBeenCalled();
  });

  it("treats a missing intent during finalization as a concurrent completion", async () => {
    mocks.findAccountDeletionIntent.mockResolvedValue(null);

    await expect(
      deleteUser("confirmation-token", "owner@example.com"),
    ).resolves.toBeUndefined();
    expect(mocks.closeStripeCustomerForAccountDeletion).toHaveBeenCalled();
    expect(mocks.enqueueUserStorageCleanups).not.toHaveBeenCalled();
    expect(mocks.prepareAccountDeletionOutboxes).not.toHaveBeenCalled();
    expect(mocks.deleteUserById).not.toHaveBeenCalled();
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("keeps local deletion retryable when the audit write fails", async () => {
    mocks.addAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      deleteUser("confirmation-token", "owner@example.com"),
    ).rejects.toThrow("audit unavailable");

    expect(mocks.enqueueUserStorageCleanups).toHaveBeenCalled();
    expect(mocks.prepareAccountDeletionOutboxes).toHaveBeenCalled();
    expect(mocks.deleteUserById).not.toHaveBeenCalled();
  });
});
