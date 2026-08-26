import { describe, expect, it, vi } from "vitest";
import {
  bindPackageCheckoutSession,
  getOrCreatePackageCheckoutAttempt,
  markPackageCheckoutAttemptTerminal,
  resolvePackageCheckoutAttemptIntervention,
  preparePackageDeletionOutboxes,
} from "../../packages/db/src/package-checkout-attempt";
import { withPackageCheckoutAttemptToken, withoutPackageCheckoutAttemptToken } from "../../packages/db/src/package-checkout-attempt";

describe("package Checkout attempts", () => {
  it("persists exact replay params with the attempt token in both metadata locations", () => {
    const original = JSON.stringify({ metadata: { packageId: "p1" }, payment_intent_data: { metadata: { packageId: "p1" } } });
    const persisted = JSON.parse(withPackageCheckoutAttemptToken(original, "attempt-1"));
    expect(persisted.metadata.packageCheckoutAttemptId).toBe("attempt-1");
    expect(persisted.payment_intent_data.metadata.packageCheckoutAttemptId).toBe("attempt-1");
    expect(withoutPackageCheckoutAttemptToken(persisted)).toEqual(JSON.parse(original));
  });

  it("rotates the discovery token when a terminal generation starts again", async () => {
    const existing = { id: "a1", discoveryToken: "old-token", userId: "u1", packageId: "p1", fingerprint: "old", checkoutKey: "old-key", stripeCheckoutSessionId: null, customerId: "cus_1", paramsJson: "{}", status: "terminal", expiresAt: new Date() };
    const upsert = vi.fn().mockResolvedValue({ ...existing, status: "open", discoveryToken: "new-token", checkoutKey: "new-key" });
    const tx = { package: { findUnique: vi.fn().mockResolvedValue({ id: "p1", userId: "seller" }) }, accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) }, packageCheckoutResolution: { findFirst: vi.fn().mockResolvedValue(null) }, packageCheckoutAttempt: { findUnique: vi.fn().mockResolvedValue(existing), upsert } };
    await getOrCreatePackageCheckoutAttempt({ userId: "u1", packageId: "p1", fingerprint: "new", customerId: "cus_1", paramsJson: JSON.stringify({ metadata: {} }), expiresAt: new Date(), prisma: tx as never });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ discoveryToken: expect.not.stringMatching("old-token"), paramsJson: expect.stringContaining("packageCheckoutAttemptId") }) }));
  });
  it("keeps a network retry on the same open attempt and rotates terminal attempts", async () => {
    const existing = {
      id: "attempt-1",
      userId: "user-1",
      packageId: "package-1",
      fingerprint: "fingerprint-a",
      customerId: "cus_1",
      paramsJson: "{}",
      checkoutKey: "key-a",
      stripeCheckoutSessionId: null,
      status: "open",
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const tx = {
      package: { findUnique: vi.fn().mockResolvedValue({ id: "package-1", userId: "seller-1" }) },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      packageCheckoutResolution: { findFirst: vi.fn().mockResolvedValue(null) },
      packageCheckoutAttempt: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(existing)
          .mockResolvedValueOnce({
            ...existing,
            status: "terminal",
            stripeCheckoutSessionId: null,
          }),
        upsert: vi.fn().mockResolvedValue({ ...existing, checkoutKey: "key-b" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const first = await getOrCreatePackageCheckoutAttempt({
      userId: "user-1",
      packageId: "package-1",
      fingerprint: "fingerprint-a",
      customerId: "cus_1",
      paramsJson: "{}",
      expiresAt: existing.expiresAt,
      now: new Date("2026-08-25T00:00:00.000Z"),
      prisma: tx as never,
    });
    await markPackageCheckoutAttemptTerminal({
      id: "attempt-1",
      checkoutKey: "key-a",
      stripeCheckoutSessionId: "cs_old",
      prisma: tx as never,
    });
    const rotated = await getOrCreatePackageCheckoutAttempt({
      userId: "user-1",
      packageId: "package-1",
      fingerprint: "fingerprint-a",
      customerId: "cus_1",
      paramsJson: "{}",
      expiresAt: existing.expiresAt,
      now: new Date("2026-08-25T00:00:00.000Z"),
      prisma: tx as never,
    });

    expect(first.checkoutKey).toBe("key-a");
    expect(rotated.checkoutKey).toBe("key-b");
    expect(tx.packageCheckoutAttempt.upsert).toHaveBeenCalledTimes(1);
  });

  it("marks only the matching attempt terminal", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await markPackageCheckoutAttemptTerminal({
      id: "attempt-1",
      checkoutKey: "key-a",
      stripeCheckoutSessionId: null,
      prisma: { packageCheckoutAttempt: { updateMany } } as never,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "attempt-1",
        checkoutKey: "key-a",
        status: "open",
        stripeCheckoutSessionId: null,
      },
      data: { status: "terminal", stripeCheckoutSessionId: null },
    });
  });

  it("lets an operator terminalize an intervention only with the exact key", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await resolvePackageCheckoutAttemptIntervention({ id: "a1", checkoutKey: "key-a", discoveryToken: "token-a", remoteResolution: { sessionId: "cs_expired", status: "expired" }, prisma: { packageCheckoutAttempt: { updateMany } } as never });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", checkoutKey: "key-a", discoveryToken: "token-a", status: "intervention", stripeCheckoutSessionId: null }, data: expect.objectContaining({ status: "terminal" }) }));
  });

  it("blocks fingerprint changes while an unbound remote outcome is unknown", async () => {
    const oldAttempt = {
      id: "attempt-1", userId: "user-1", packageId: "package-1", fingerprint: "old",
      checkoutKey: "old-key", stripeCheckoutSessionId: null, status: "open",
      customerId: "cus_1", paramsJson: "{}",
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const tx = {
      package: { findUnique: vi.fn().mockResolvedValue({ id: "package-1", userId: "seller-1" }) },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      packageCheckoutResolution: { findFirst: vi.fn().mockResolvedValue(null) },
      packageCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue(oldAttempt),
        upsert: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await getOrCreatePackageCheckoutAttempt({ userId: "user-1", packageId: "package-1", fingerprint: "old", customerId: "cus_1", paramsJson: "{}", expiresAt: oldAttempt.expiresAt, prisma: tx as never });
    await expect(getOrCreatePackageCheckoutAttempt({ userId: "user-1", packageId: "package-1", fingerprint: "new", customerId: "cus_1", paramsJson: "changed", expiresAt: oldAttempt.expiresAt, prisma: tx as never })).resolves.toMatchObject({ id: "attempt-1", fingerprint: "old" });
    expect(tx.packageCheckoutAttempt.upsert).not.toHaveBeenCalled();
  });

  it("blocks a new generation while duplicate refunds are pending", async () => {
    const existing = { id: "attempt-1", userId: "user-1", packageId: "package-1", fingerprint: "old", checkoutKey: "old-key", stripeCheckoutSessionId: null, status: "intervention", customerId: "cus_1", paramsJson: "{}", expiresAt: new Date() };
    const tx = {
      package: { findUnique: vi.fn().mockResolvedValue({ id: "package-1", userId: "seller-1" }) },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      packageCheckoutAttempt: { findUnique: vi.fn().mockResolvedValue(existing), upsert: vi.fn() },
      packageCheckoutResolution: { findFirst: vi.fn().mockResolvedValue({ id: "resolution-1", status: "refund_pending" }) },
    };
    await expect(getOrCreatePackageCheckoutAttempt({ userId: "user-1", packageId: "package-1", fingerprint: "new", customerId: "cus_1", paramsJson: "{}", expiresAt: existing.expiresAt, prisma: tx as never })).rejects.toThrow("awaiting duplicate payment refunds");
  });

  it("writes cleanup outbox for a late bind after User cascade", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(undefined);
    const tx = {
      packageCheckoutAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attempt-1", userId: "user-1", packageId: "package-1", customerId: "cus_1", paramsJson: "{}",
          checkoutKey: "key-1", stripeCheckoutSessionId: null, accountDeletionAt: new Date(),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      customer: { findUnique: vi.fn().mockResolvedValue(null) },
      stripeCheckoutCleanup: {
        upsert,
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn(),
      },
    };
    await expect(bindPackageCheckoutSession({ id: "attempt-1", checkoutKey: "key-1", stripeCheckoutSessionId: "cs_late", expiresAt: new Date(), prisma: tx as never })).resolves.toBe("account-deletion-authorized");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sessionId: "cs_late", customerId: "cus_1" }),
    }));
  });

  it("blocks creation after an account-deletion reservation in the same transaction", async () => {
    const tx = {
      package: { findUnique: vi.fn().mockResolvedValue({ id: "package-1", userId: "seller-1" }) },
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue({ userId: "user-1" }) },
      packageCheckoutAttempt: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
      packageCheckoutResolution: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    await expect(getOrCreatePackageCheckoutAttempt({
      userId: "user-1", packageId: "package-1", fingerprint: "fp", customerId: "cus_1", paramsJson: "{}", expiresAt: new Date(), prisma: tx as never,
    })).rejects.toThrow("seller account deletion is already authorized");
    expect(tx.packageCheckoutAttempt.upsert).not.toHaveBeenCalled();
  });

  it("prepares seller package deletion without cascading buyer attempts", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const tx = {
      packageCheckoutAttempt: {
        findMany: vi.fn().mockResolvedValue([{ id: "a1", userId: "buyer", packageId: "pkg", customerId: "cus_buyer", paramsJson: "{}", stripeCheckoutSessionId: "cs_1" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      stripeCheckoutCleanup: { findUnique: vi.fn().mockResolvedValue(null), create, update: vi.fn() },
    };
    await preparePackageDeletionOutboxes({ packageId: "pkg", prisma: tx as never });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sessionId: "cs_1", userId: "buyer", customerId: "cus_buyer" }) }));
    expect(tx.packageCheckoutAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { packageId: "pkg" }, data: expect.objectContaining({ accountDeletionAt: expect.any(Date) }) }));
  });
});
