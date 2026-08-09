import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createUserPackage,
  PACKAGE_PAYMENT_EVENT_RANK,
  recordPackagePaymentSucceeded,
  restorePackagePayment,
  revokePackagePayment,
  setDbProvider,
} from "@beutl/db";

type History = {
  paymentId: string;
  userId: string;
  packageId: string;
  fulfillmentValidated: boolean;
  revokedAt: Date | null;
  revocationReason: string | null;
  stripeStateEventId: string | null;
  stripeStateEventCreatedAt: Date | null;
  stripeStateEventRank: number;
};

function createPaymentStatePrisma() {
  const histories = new Map<string, History>();
  const packages = new Map<string, { paymentManaged: boolean }>();
  let concurrentHistoryAfterRollback: History | null = null;
  let raceNextHistoryCreate = false;
  let transactionAttempts = 0;
  const packageKey = (userId: string, packageId: string) =>
    `${userId}:${packageId}`;
  const clone = (history: History): History => ({
    ...history,
    revokedAt: history.revokedAt ? new Date(history.revokedAt) : null,
    stripeStateEventCreatedAt: history.stripeStateEventCreatedAt
      ? new Date(history.stripeStateEventCreatedAt)
      : null,
  });

  const userPaymentHistory = {
    findUnique: async ({ where }: { where: { paymentId: string } }) => {
      const history = histories.get(where.paymentId);
      return history ? clone(history) : null;
    },
    findFirst: async ({
      where,
    }: {
      where: {
        userId: string;
        packageId: string;
        fulfillmentValidated: true;
        revokedAt: null;
      };
    }) =>
      [...histories.values()].find(
        (history) =>
          history.userId === where.userId &&
          history.packageId === where.packageId &&
          history.fulfillmentValidated === where.fulfillmentValidated &&
          history.revokedAt === null,
      ) ?? null,
    create: async ({ data }: { data: History }) => {
      if (histories.has(data.paymentId)) {
        throw new Error("duplicate payment");
      }
      const history = clone(data);
      if (raceNextHistoryCreate) {
        raceNextHistoryCreate = false;
        concurrentHistoryAfterRollback = history;
        throw Object.assign(new Error("concurrent payment insert"), {
          code: "P2002",
        });
      }
      histories.set(history.paymentId, history);
      return clone(history);
    },
    update: async ({
      where,
      data,
    }: {
      where: { paymentId: string };
      data: Partial<History>;
    }) => {
      const history = histories.get(where.paymentId);
      if (!history) {
        throw new Error("missing payment");
      }
      const updated = clone({ ...history, ...data });
      histories.set(updated.paymentId, updated);
      return clone(updated);
    },
    count: async ({
      where,
    }: {
      where: {
        userId: string;
        packageId: string;
        fulfillmentValidated: true;
        revokedAt: null;
      };
    }) =>
      [...histories.values()].filter(
        (history) =>
          history.userId === where.userId &&
          history.packageId === where.packageId &&
          history.fulfillmentValidated === where.fulfillmentValidated &&
          history.revokedAt === null,
      ).length,
  };
  const userPackage = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_packageId: { userId: string; packageId: string } };
      create: { userId: string; packageId: string; paymentManaged: boolean };
      update: { paymentManaged?: boolean };
    }) => {
      const key = packageKey(
        where.userId_packageId.userId,
        where.userId_packageId.packageId,
      );
      if (!packages.has(key)) {
        packages.set(key, { paymentManaged: create.paymentManaged });
      } else if (update.paymentManaged !== undefined) {
        packages.set(key, { paymentManaged: update.paymentManaged });
      }
      return packages.get(key);
    },
    deleteMany: async ({
      where,
    }: {
      where: {
        userId: string;
        packageId: string;
        paymentManaged: boolean;
      };
    }) => {
      const key = packageKey(where.userId, where.packageId);
      const current = packages.get(key);
      if (current?.paymentManaged === where.paymentManaged) {
        packages.delete(key);
        return { count: 1 };
      }
      return { count: 0 };
    },
  };
  let packageAvailable = true;
  const packageDelegate = {
    findFirst: async () => (packageAvailable ? { id: "package-1" } : null),
  };
  const prisma = {
    package: packageDelegate,
    userPaymentHistory,
    userPackage,
    $transaction: async <T>(
      callback: (tx: {
        userPaymentHistory: typeof userPaymentHistory;
        userPackage: typeof userPackage;
        package: typeof packageDelegate;
      }) => Promise<T>,
    ) => {
      transactionAttempts++;
      const historiesSnapshot = new Map(
        [...histories].map(([key, value]) => [key, clone(value)]),
      );
      const packagesSnapshot = new Map(
        [...packages].map(([key, value]) => [key, { ...value }]),
      );
      try {
        return await callback({
          package: packageDelegate,
          userPaymentHistory,
          userPackage,
        });
      } catch (error) {
        histories.clear();
        for (const [key, value] of historiesSnapshot) {
          histories.set(key, value);
        }
        packages.clear();
        for (const [key, value] of packagesSnapshot) {
          packages.set(key, value);
        }
        if (concurrentHistoryAfterRollback) {
          const history = concurrentHistoryAfterRollback;
          concurrentHistoryAfterRollback = null;
          histories.set(history.paymentId, clone(history));
          if (history.fulfillmentValidated && !history.revokedAt) {
            packages.set(packageKey(history.userId, history.packageId), {
              paymentManaged: true,
            });
          }
        }
        throw error;
      }
    },
  };

  return {
    prisma,
    history(paymentId: string) {
      const history = histories.get(paymentId);
      return history ? clone(history) : null;
    },
    package(userId: string, packageId: string) {
      return packages.get(packageKey(userId, packageId)) ?? null;
    },
    seedPackage(userId: string, packageId: string, paymentManaged: boolean) {
      packages.set(packageKey(userId, packageId), { paymentManaged });
    },
    removePackage(userId: string, packageId: string) {
      packages.delete(packageKey(userId, packageId));
    },
    raceNextPaymentHistoryCreate() {
      raceNextHistoryCreate = true;
    },
    transactionAttempts() {
      return transactionAttempts;
    },
    setPackageAvailable(value: boolean) {
      packageAvailable = value;
    },
  };
}

const SUCCEEDED_AT = new Date("2026-08-09T00:00:00.000Z");
const REFUNDED_AT = new Date("2026-08-09T00:01:00.000Z");
const RESTORED_AT = new Date("2026-08-09T00:02:00.000Z");

describe("package payment migration cutover", () => {
  it("marks old-Worker library writes as payment-managed by default", () => {
    const migration = readFileSync(
      new URL(
        "../../apps/web/prisma/migrations/20260809171000_track_package_payment_state/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'ADD COLUMN "paymentManaged" BOOL NOT NULL DEFAULT true;',
    );
    expect(migration).not.toContain('UPDATE "UserPackage"');
  });
});

describe("package payment entitlement state", () => {
  let store: ReturnType<typeof createPaymentStatePrisma>;

  beforeEach(() => {
    store = createPaymentStatePrisma();
    setDbProvider(async () => store.prisma as never);
  });

  it("creates an active payment-managed library entitlement", async () => {
    await recordPackagePaymentSucceeded({
      reference: {
        paymentId: "pi_1",
        userId: "user-1",
        packageId: "package-1",
      },
      billing: { amount: 1_000, currency: "usd" },
      event: {
        id: "evt_succeeded",
        createdAt: SUCCEEDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
      },
    });

    expect(store.history("pi_1")).toMatchObject({
      fulfillmentValidated: true,
      revokedAt: null,
    });
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });
  });

  it("retries a concurrent payment-history insert", async () => {
    store.raceNextPaymentHistoryCreate();

    await recordSuccess("pi_concurrent");

    expect(store.transactionAttempts()).toBe(2);
    expect(store.history("pi_concurrent")).toMatchObject({
      fulfillmentValidated: true,
      revokedAt: null,
    });
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });
  });

  it("does not recreate a paid entry after its active payment disappears", async () => {
    await recordSuccess("pi_reacquire_race");
    await revokePackagePayment({
      paymentId: "pi_reacquire_race",
      event: {
        id: "evt_refunded_before_readd",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });

    await expect(
      createUserPackage({
        userId: "user-1",
        packageId: "package-1",
        requireActivePayment: true,
      }),
    ).resolves.toBeNull();
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("does not fulfill after the package price changes", async () => {
    store.setPackageAvailable(false);

    await expect(
      recordPackagePaymentSucceeded({
        reference: {
          paymentId: "pi_stale",
          userId: "user-1",
          packageId: "package-1",
        },
        billing: { amount: 1_000, currency: "usd" },
        event: {
          id: "evt_stale_price",
          createdAt: SUCCEEDED_AT,
          rank: PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
        },
      }),
    ).resolves.toBeNull();
    expect(store.history("pi_stale")).toBeNull();
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("revokes refunded access and ignores a delayed success delivery", async () => {
    await recordSuccess("pi_1");
    await revokePackagePayment({
      paymentId: "pi_1",
      event: {
        id: "evt_refunded",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });

    expect(store.history("pi_1")?.revokedAt).toEqual(REFUNDED_AT);
    expect(store.package("user-1", "package-1")).toBeNull();

    await recordSuccess("pi_1");
    expect(store.history("pi_1")?.revokedAt).toEqual(REFUNDED_AT);
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("keeps a succeeded refund terminal across later dispute events", async () => {
    await recordSuccess("pi_refunded_then_disputed");
    await revokePackagePayment({
      paymentId: "pi_refunded_then_disputed",
      event: {
        id: "evt_refunded",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });
    await revokePackagePayment({
      paymentId: "pi_refunded_then_disputed",
      event: {
        id: "evt_dispute_opened_after_refund",
        createdAt: RESTORED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      },
      reason: "disputed",
    });

    expect(store.history("pi_refunded_then_disputed")).toMatchObject({
      revokedAt: REFUNDED_AT,
      revocationReason: "refunded",
      stripeStateEventId: "evt_refunded",
      stripeStateEventRank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
    });
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("does not restore an unvalidated reversal tombstone", async () => {
    await recordReversal("pi_tombstone");

    expect(store.history("pi_tombstone")).toMatchObject({
      fulfillmentValidated: false,
      revokedAt: REFUNDED_AT,
    });
    await expect(
      restorePackagePayment({
        paymentId: "pi_tombstone",
        event: {
          id: "evt_dispute_won",
          createdAt: RESTORED_AT,
          rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
        },
      }),
    ).resolves.toBeNull();
    expect(store.history("pi_tombstone")?.revokedAt).toEqual(REFUNDED_AT);
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("validates a tombstone without overriding its newer reversal", async () => {
    await recordReversal("pi_tombstone");

    await recordSuccess("pi_tombstone");
    expect(store.history("pi_tombstone")).toMatchObject({
      fulfillmentValidated: true,
      revokedAt: REFUNDED_AT,
      stripeStateEventId: "evt_dispute_opened_pi_tombstone",
    });

    await restorePackagePayment({
      paymentId: "pi_tombstone",
      event: {
        id: "evt_dispute_won",
        createdAt: RESTORED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
      },
    });
    expect(store.history("pi_tombstone")?.revokedAt).toBeNull();
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });
  });

  it("restores access after a later dispute resolution", async () => {
    await recordSuccess("pi_1");
    await revokePackagePayment({
      paymentId: "pi_1",
      event: {
        id: "evt_dispute_opened",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      },
      reason: "disputed",
    });

    await restorePackagePayment({
      paymentId: "pi_1",
      event: {
        id: "evt_dispute_won",
        createdAt: RESTORED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
      },
    });

    expect(store.history("pi_1")?.revokedAt).toBeNull();
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });
  });

  it("does not re-add a user-removed package on restoration replays", async () => {
    await recordSuccess("pi_restored_once");
    await revokePackagePayment({
      paymentId: "pi_restored_once",
      event: {
        id: "evt_dispute_opened",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      },
      reason: "disputed",
    });
    await restorePackagePayment({
      paymentId: "pi_restored_once",
      event: {
        id: "evt_dispute_won",
        createdAt: RESTORED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
      },
    });
    store.removePackage("user-1", "package-1");

    await restorePackagePayment({
      paymentId: "pi_restored_once",
      event: {
        id: "evt_funds_reinstated",
        createdAt: new Date("2026-08-09T00:03:00.000Z"),
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
      },
    });

    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("lets a terminal dispute resolution win a same-second tie", async () => {
    await recordSuccess("pi_same_second");
    await revokePackagePayment({
      paymentId: "pi_same_second",
      event: {
        id: "evt_dispute_opened",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      },
      reason: "disputed",
    });

    await restorePackagePayment({
      paymentId: "pi_same_second",
      event: {
        id: "evt_dispute_won",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
      },
    });

    expect(store.history("pi_same_second")).toMatchObject({
      revokedAt: null,
      stripeStateEventId: "evt_dispute_won",
      stripeStateEventRank: PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
    });
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });
  });

  it("keeps access while another active payment exists", async () => {
    await recordSuccess("pi_1");
    await recordSuccess("pi_2");

    await revokePackagePayment({
      paymentId: "pi_1",
      event: {
        id: "evt_refunded",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });

    expect(store.package("user-1", "package-1")).not.toBeNull();
  });

  it("re-adds a paid package as payment-managed", async () => {
    await recordSuccess("pi_reacquired");
    store.removePackage("user-1", "package-1");

    await createUserPackage({
      userId: "user-1",
      packageId: "package-1",
    });
    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: true,
    });

    await revokePackagePayment({
      paymentId: "pi_reacquired",
      event: {
        id: "evt_refunded_reacquired",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });
    expect(store.package("user-1", "package-1")).toBeNull();
  });

  it("does not remove a manually managed library entry", async () => {
    store.seedPackage("user-1", "package-1", false);
    await recordSuccess("pi_1");
    await revokePackagePayment({
      paymentId: "pi_1",
      event: {
        id: "evt_refunded",
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      },
      reason: "refunded",
    });

    expect(store.package("user-1", "package-1")).toEqual({
      paymentManaged: false,
    });
  });

  it("never rebinds a Stripe payment to another user", async () => {
    await recordSuccess("pi_1");

    await expect(
      recordPackagePaymentSucceeded({
        reference: {
          paymentId: "pi_1",
          userId: "attacker",
          packageId: "package-1",
        },
        billing: { amount: 1_000, currency: "usd" },
        event: {
          id: "evt_rebound",
          createdAt: RESTORED_AT,
          rank: PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
        },
      }),
    ).rejects.toThrow("Package payment identity cannot be rebound");
  });

  async function recordSuccess(paymentId: string) {
    await recordPackagePaymentSucceeded({
      reference: {
        paymentId,
        userId: "user-1",
        packageId: "package-1",
      },
      billing: { amount: 1_000, currency: "usd" },
      event: {
        id: `evt_succeeded_${paymentId}`,
        createdAt: SUCCEEDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
      },
    });
  }

  async function recordReversal(paymentId: string) {
    await revokePackagePayment({
      paymentId,
      reference: {
        userId: "user-1",
        packageId: "package-1",
      },
      event: {
        id: `evt_dispute_opened_${paymentId}`,
        createdAt: REFUNDED_AT,
        rank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      },
      reason: "disputed",
    });
  }
});
