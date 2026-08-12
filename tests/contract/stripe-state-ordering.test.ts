import { describe, expect, it } from "vitest";
import {
  reconcilePurchasedCreditReversal,
  reconcileSubscriptionObservation,
  setDbProvider,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createBarrier(parties: number) {
  let arrivals = 0;
  const released = deferred();
  return async () => {
    arrivals++;
    if (arrivals === parties) {
      released.resolve();
    }
    await released.promise;
  };
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

describe("monotonic Stripe state persistence", () => {
  it("uses a barrier and CAS so an equal-time stalled subscription observation cannot overwrite the newer period", async () => {
    const bothRead = createBarrier(2);
    const newerWritten = deferred();
    let initialReads = 0;
    let state = {
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
      stripeEventId: "evt_baseline",
      stripeEventCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      stripeCanonicalObservedAt: new Date("2026-07-01T00:00:00.000Z"),
      stripeObservationRank: "baseline",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };

    const prisma: any = {
      subscription: {
        findUnique: async () => {
          const snapshot = { ...state };
          if (initialReads++ < 2) {
            await bothRead();
          }
          return snapshot;
        },
        upsert: async () => ({ ...state }),
        updateMany: async ({ where, data }: any) => {
          if (data.stripeEventId === "evt_old") {
            await newerWritten.promise;
          }
          const matches =
            state.userId === where.userId &&
            state.stripeSubscriptionId === where.stripeSubscriptionId &&
            state.stripeEventId === where.stripeEventId &&
            state.stripeObservationRank === where.stripeObservationRank &&
            sameDate(
              state.stripeEventCreatedAt,
              where.stripeEventCreatedAt,
            ) &&
            sameDate(
              state.stripeCanonicalObservedAt,
              where.stripeCanonicalObservedAt,
            );
          if (!matches) return { count: 0 };
          state = { ...state, ...data, updatedAt: new Date() };
          if (data.stripeEventId === "evt_new") {
            newerWritten.resolve();
          }
          return { count: 1 };
        },
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback(prisma),
    };
    setDbProvider(async () => prisma as never);

    const oldObservation = reconcileSubscriptionObservation({
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "past_due",
      planId: "pro",
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeSubscriptionCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      stripeEventId: "evt_old",
      stripeEventCreatedAt: new Date("2026-08-01T00:00:01.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.100Z"),
    });
    const newObservation = reconcileSubscriptionObservation({
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeSubscriptionCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      stripeEventId: "evt_new",
      stripeEventCreatedAt: new Date("2026-08-01T00:00:01.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.200Z"),
    });

    await Promise.all([oldObservation, newObservation]);

    expect(state).toMatchObject({
      status: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      stripeEventId: "evt_new",
      stripeEventCreatedAt: new Date("2026-08-01T00:00:01.000Z"),
    });
  });

  it("lets a later canonical observation recover reversible states in the same Stripe second", async () => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    const eventTime = new Date("2026-08-01T00:00:01.000Z");
    const common = {
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      planId: "pro",
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeSubscriptionCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      stripeEventCreatedAt: eventTime,
    };

    await reconcileSubscriptionObservation({
      ...common,
      status: "active",
      stripeEventId: "evt_z_active_first",
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.100Z"),
    });
    await reconcileSubscriptionObservation({
      ...common,
      status: "unpaid",
      stripeEventId: "evt_zz_unpaid",
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.200Z"),
    });
    await reconcileSubscriptionObservation({
      ...common,
      status: "active",
      stripeEventId: "evt_a_active_recovery",
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.300Z"),
    });

    expect(memory.state.subscriptions.get("user-1")).toMatchObject({
      status: "active",
      stripeEventId: "evt_a_active_recovery",
      stripeEventCreatedAt: eventTime,
    });
  });

  it("keeps an irreversible terminal subscription monotonic", async () => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    const common = {
      userId: "user-1",
      stripeSubscriptionId: "sub_1",
      planId: "pro",
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeSubscriptionCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };

    await reconcileSubscriptionObservation({
      ...common,
      status: "canceled",
      stripeEventId: "evt_terminal",
      stripeEventCreatedAt: new Date("2026-08-01T00:00:01.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:01.100Z"),
    });
    await reconcileSubscriptionObservation({
      ...common,
      status: "active",
      stripeEventId: "evt_impossible_recovery",
      stripeEventCreatedAt: new Date("2026-08-01T00:00:02.000Z"),
      stripeCanonicalObservedAt: new Date("2026-08-01T00:00:02.100Z"),
    });

    expect(memory.state.subscriptions.get("user-1")).toMatchObject({
      status: "canceled",
      stripeEventId: "evt_terminal",
    });
  });

  it.each([
    ["refund", "pending", "failed"],
    ["dispute", "needs_response", "won"],
  ] as const)(
    "keeps a terminal %s canonical state when an equal-time pending observation resumes",
    async (reversalKind, pendingStatus, terminalStatus) => {
      const bothRead = createBarrier(2);
      const terminalWritten = deferred();
      let initialReads = 0;
      let state = {
        id: "reversal-row",
        stripePaymentId: "pi_1",
        stripeReversalKind: reversalKind,
        stripeReversalId: "reversal_1",
        stripeAmount: 1_000,
        stripeCurrency: "usd",
        status: pendingStatus,
        active: true,
        progressionRank: 10,
        stripeEventId: "evt_baseline",
        stripeEventCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
        revision: 1,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      };

      const prisma: any = {
        stripeCreditReversal: {
          upsert: async () => {
            const snapshot = { ...state };
            if (initialReads++ < 2) {
              await bothRead();
            }
            return snapshot;
          },
          updateMany: async ({ where, data }: any) => {
            if (data.status === pendingStatus) {
              await terminalWritten.promise;
            }
            const matches =
              state.id === where.id &&
              state.revision === where.revision &&
              state.progressionRank === where.progressionRank &&
              state.stripeEventId === where.stripeEventId &&
              sameDate(
                state.stripeEventCreatedAt,
                where.stripeEventCreatedAt,
              );
            if (!matches) return { count: 0 };
            state = { ...state, ...data, updatedAt: new Date() };
            if (data.status === terminalStatus) {
              terminalWritten.resolve();
            }
            return { count: 1 };
          },
          findUnique: async () => ({ ...state }),
        },
        creditTransaction: {
          findUnique: async () => null,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          await callback(prisma),
      };
      setDbProvider(async () => prisma as never);
      const eventTime = new Date("2026-08-01T00:00:01.000Z");

      const stalledPending = reconcilePurchasedCreditReversal({
        stripePaymentId: "pi_1",
        stripePayment: { amount: 1_000, currency: "usd" },
        reversalKind,
        reversalId: "reversal_1",
        reversalAmount: 1_000,
        reversalCurrency: "usd",
        status: pendingStatus,
        active: true,
        stripeEventId: "evt_z_pending",
        stripeEventCreatedAt: eventTime,
      });
      const terminal = reconcilePurchasedCreditReversal({
        stripePaymentId: "pi_1",
        stripePayment: { amount: 1_000, currency: "usd" },
        reversalKind,
        reversalId: "reversal_1",
        reversalAmount: 1_000,
        reversalCurrency: "usd",
        status: terminalStatus,
        active: false,
        stripeEventId: "evt_a_terminal",
        stripeEventCreatedAt: eventTime,
      });

      await Promise.all([stalledPending, terminal]);

      expect(state).toMatchObject({
        status: terminalStatus,
        active: false,
        progressionRank: 100,
        stripeEventId: "evt_a_terminal",
        stripeEventCreatedAt: eventTime,
        revision: 2,
      });
    },
  );
});
