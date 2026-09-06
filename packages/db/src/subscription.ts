import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

const MAX_OBSERVATION_CAS_ATTEMPTS = 8;

const IRREVERSIBLE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

type StripeSubscriptionObservation = {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  billingOfferId?: string | null;
  stripeSubscriptionCreatedAt: Date | null;
  stripeEventId: string;
  stripeEventCreatedAt: Date;
  stripeCanonicalObservedAt: Date;
  replaceExistingSubscription?: boolean;
};

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}

function rankTimestamp(value: Date | null): string {
  if (value === null) {
    return "0000000000000000";
  }
  assertValidDate(value, "subscription observation timestamp");
  const milliseconds = value.getTime();
  if (milliseconds < 0) {
    throw new RangeError("subscription observation timestamps must be non-negative");
  }
  return String(milliseconds).padStart(16, "0");
}

function createSubscriptionObservationRank({
  stripeSubscriptionId,
  stripeSubscriptionCreatedAt,
  currentPeriodStart,
  currentPeriodEnd,
}: Pick<
  StripeSubscriptionObservation,
  | "stripeSubscriptionId"
  | "stripeSubscriptionCreatedAt"
  | "currentPeriodStart"
  | "currentPeriodEnd"
>): string {
  return [
    rankTimestamp(stripeSubscriptionCreatedAt),
    rankTimestamp(currentPeriodStart),
    rankTimestamp(currentPeriodEnd),
    stripeSubscriptionId,
  ].join(":");
}

function compareSubscriptionObservation(
  incoming: {
    stripeEventCreatedAt: Date;
    stripeCanonicalObservedAt: Date;
    stripeEventId: string;
    stripeObservationRank: string;
    stripeSubscriptionId: string;
    status: string;
  },
  stored: {
    stripeEventCreatedAt: Date | null;
    stripeCanonicalObservedAt: Date | null;
    stripeEventId: string | null;
    stripeObservationRank: string | null;
    stripeSubscriptionId: string;
    status: string;
  },
): number {
  if (incoming.stripeSubscriptionId === stored.stripeSubscriptionId) {
    const incomingIsTerminal = IRREVERSIBLE_SUBSCRIPTION_STATUSES.has(
      incoming.status,
    );
    const storedIsTerminal = IRREVERSIBLE_SUBSCRIPTION_STATUSES.has(
      stored.status,
    );
    if (incomingIsTerminal !== storedIsTerminal) {
      return incomingIsTerminal ? 1 : -1;
    }
  }

  if (stored.stripeEventCreatedAt === null) {
    return 1;
  }
  const createdDifference =
    incoming.stripeEventCreatedAt.getTime() -
    stored.stripeEventCreatedAt.getTime();
  if (createdDifference !== 0) {
    return createdDifference;
  }

  const canonicalObservedDifference =
    incoming.stripeCanonicalObservedAt.getTime() -
    (stored.stripeCanonicalObservedAt?.getTime() ?? 0);
  if (canonicalObservedDifference !== 0) {
    return canonicalObservedDifference;
  }

  const storedRank = stored.stripeObservationRank ?? "";
  if (incoming.stripeObservationRank !== storedRank) {
    return incoming.stripeObservationRank > storedRank ? 1 : -1;
  }

  const storedEventId = stored.stripeEventId ?? "";
  if (incoming.stripeEventId === storedEventId) {
    return 0;
  }
  return incoming.stripeEventId > storedEventId ? 1 : -1;
}

export async function upsertSubscription({
  userId,
  stripeSubscriptionId,
  status,
  planId,
  currentPeriodStart,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  cancelAt,
  billingOfferId,
  prisma,
}: {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: Date | null;
  billingOfferId: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.subscription.upsert({
    where: {
      userId,
    },
    create: {
      userId,
      stripeSubscriptionId,
      status,
      planId,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      cancelAt,
      billingOfferId,
    },
    update: {
      stripeSubscriptionId,
      status,
      planId,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      cancelAt,
      billingOfferId,
    },
  });
}

export async function getSubscriptionByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const subscription = await db.subscription.findUnique({
    where: {
      userId,
    },
  });
  if (!subscription) {
    return null;
  }
  const activeHold = await db.subscriptionEntitlementHold.findFirst({
    where: {
      userId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      active: true,
      ...(subscription.currentPeriodStart !== null &&
          subscription.currentPeriodEnd !== null
        ? {
            billingPeriodStart: { lt: subscription.currentPeriodEnd },
            billingPeriodEnd: { gt: subscription.currentPeriodStart },
          }
        : {}),
    },
    select: { id: true },
  });
  return {
    ...subscription,
    entitlementHeld: activeHold !== null,
  };
}

export async function findSubscriptionByStripeSubscriptionId({
  stripeSubscriptionId,
  prisma,
}: {
  stripeSubscriptionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.subscription.findUnique({ where: { stripeSubscriptionId } });
}

export async function updateSubscriptionStatus({
  userId,
  status,
  currentPeriodStart,
  currentPeriodEnd,
  prisma,
}: {
  userId: string;
  status: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.subscription.update({
    where: {
      userId,
    },
    data: {
      status,
      currentPeriodStart,
      currentPeriodEnd,
    },
  });
}

// Persist a Stripe subscription observation monotonically. Event creation time
// is the primary watermark. Stripe timestamps have one-second precision, so
// equal-second reversible states use the time at which the canonical Stripe
// object was retrieved. Only canceled/incomplete_expired are monotonic; active,
// past_due, paused, and unpaid can all recover. The conditional update is a
// database CAS, so a handler that stalled after reading cannot overwrite a
// later canonical observation.
export async function reconcileSubscriptionObservation(
  observation: StripeSubscriptionObservation,
) {
  if (observation.stripeEventId.trim().length === 0) {
    throw new RangeError("stripeEventId must not be empty");
  }
  assertValidDate(
    observation.stripeEventCreatedAt,
    "stripeEventCreatedAt",
  );
  assertValidDate(
    observation.stripeCanonicalObservedAt,
    "stripeCanonicalObservedAt",
  );
  const stripeObservationRank = createSubscriptionObservationRank(observation);
  const incoming = {
    stripeEventCreatedAt: observation.stripeEventCreatedAt,
    stripeCanonicalObservedAt: observation.stripeCanonicalObservedAt,
    stripeEventId: observation.stripeEventId,
    stripeObservationRank,
    stripeSubscriptionId: observation.stripeSubscriptionId,
    status: observation.status,
  };
  const data = {
    planId: observation.planId,
    currentPeriodStart: observation.currentPeriodStart,
    currentPeriodEnd: observation.currentPeriodEnd,
    cancelAtPeriodEnd: observation.cancelAtPeriodEnd,
    cancelAt: observation.cancelAt,
    billingOfferId: observation.billingOfferId,
    ...incoming,
  };

  for (let attempt = 0; attempt < MAX_OBSERVATION_CAS_ATTEMPTS; attempt++) {
    const result = await startRetryableTransaction(async (tx) => {
      let stored = await tx.subscription.findUnique({
        where: { userId: observation.userId },
      });

      if (!stored) {
        if (observation.replaceExistingSubscription === false) {
          return { retry: false, applied: false, subscription: null };
        }
        stored = await tx.subscription.upsert({
          where: { userId: observation.userId },
          create: {
            userId: observation.userId,
            ...data,
          },
          update: {},
        });
      }

      if (
        observation.replaceExistingSubscription === false &&
        stored.stripeSubscriptionId !== observation.stripeSubscriptionId
      ) {
        return { retry: false, applied: false, subscription: stored };
      }

      const comparison = compareSubscriptionObservation(incoming, stored);
      if (comparison < 0) {
        return { retry: false, applied: false, subscription: stored };
      }
      if (
        comparison === 0 &&
        stored.stripeSubscriptionId === observation.stripeSubscriptionId &&
        stored.status === observation.status &&
        stored.planId === observation.planId &&
        stored.currentPeriodStart?.getTime() ===
          observation.currentPeriodStart?.getTime() &&
        stored.currentPeriodEnd?.getTime() ===
          observation.currentPeriodEnd?.getTime() &&
        stored.cancelAtPeriodEnd === observation.cancelAtPeriodEnd &&
        stored.cancelAt?.getTime() === observation.cancelAt?.getTime() &&
        (observation.billingOfferId === undefined ||
          stored.billingOfferId === observation.billingOfferId)
      ) {
        return { retry: false, applied: false, subscription: stored };
      }

      const updated = await tx.subscription.updateMany({
        where: {
          userId: observation.userId,
          stripeSubscriptionId: stored.stripeSubscriptionId,
          stripeEventCreatedAt: stored.stripeEventCreatedAt,
          stripeCanonicalObservedAt: stored.stripeCanonicalObservedAt,
          stripeEventId: stored.stripeEventId,
          stripeObservationRank: stored.stripeObservationRank,
        },
        data,
      });
      if (updated.count !== 1) {
        return { retry: true, applied: false, subscription: null };
      }

      return {
        retry: false,
        applied: true,
        subscription: await tx.subscription.findUnique({
          where: { userId: observation.userId },
        }),
      };
    });

    if (!result.retry) {
      return result;
    }
  }

  throw new Error("Could not reconcile the Stripe subscription observation");
}

export type SubscriptionEntitlementHoldKind = "refund" | "dispute";

const TERMINAL_HOLD_STATUSES = {
  refund: new Set(["succeeded", "failed", "canceled"]),
  dispute: new Set(["lost", "won", "prevented", "warning_closed"]),
} as const;

function entitlementHoldProgressionRank(
  kind: SubscriptionEntitlementHoldKind,
  status: string,
): number {
  return TERMINAL_HOLD_STATUSES[kind].has(status) ? 100 : 10;
}

function compareEntitlementHoldCanonicalObservation(
  incoming: {
    stripeCanonicalObservedAt: Date;
    stripeEventCreatedAt: Date;
    stripeEventId: string;
  },
  stored: {
    stripeCanonicalObservedAt: Date | null;
    stripeEventCreatedAt: Date;
    stripeEventId: string;
  },
): number {
  const canonicalDifference =
    incoming.stripeCanonicalObservedAt.getTime() -
    (stored.stripeCanonicalObservedAt?.getTime() ?? 0);
  if (canonicalDifference !== 0) return canonicalDifference;
  const eventDifference =
    incoming.stripeEventCreatedAt.getTime() -
    stored.stripeEventCreatedAt.getTime();
  if (eventDifference !== 0) return eventDifference;
  if (incoming.stripeEventId === stored.stripeEventId) return 0;
  return incoming.stripeEventId > stored.stripeEventId ? 1 : -1;
}

export async function reconcileSubscriptionEntitlementHold({
  userId,
  stripeSubscriptionId,
  stripePaymentIntentId,
  stripeReversalKind,
  stripeReversalId,
  stripeInvoiceId,
  billingPeriodStart,
  billingPeriodEnd,
  paymentAmount,
  reversalAmount,
  currency,
  status,
  active,
  stripeEventId,
  stripeEventCreatedAt,
  stripeCanonicalObservedAt,
  prisma,
}: {
  userId: string;
  stripeSubscriptionId: string;
  stripePaymentIntentId: string;
  stripeReversalKind: SubscriptionEntitlementHoldKind;
  stripeReversalId: string;
  stripeInvoiceId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  paymentAmount: number;
  reversalAmount: number;
  currency: string;
  status: string;
  active: boolean;
  stripeEventId: string;
  stripeEventCreatedAt: Date;
  stripeCanonicalObservedAt: Date;
  prisma?: PrismaTransaction;
}) {
  assertValidDate(stripeEventCreatedAt, "stripeEventCreatedAt");
  assertValidDate(stripeCanonicalObservedAt, "stripeCanonicalObservedAt");
  assertValidDate(billingPeriodStart, "billingPeriodStart");
  assertValidDate(billingPeriodEnd, "billingPeriodEnd");
  if (billingPeriodStart.getTime() >= billingPeriodEnd.getTime()) {
    throw new RangeError("The entitlement hold billing period is invalid");
  }
  if (
    !Number.isSafeInteger(paymentAmount) ||
    paymentAmount <= 0 ||
    !Number.isSafeInteger(reversalAmount) ||
    reversalAmount < 0
  ) {
    throw new RangeError("The entitlement hold amounts are invalid");
  }
  const normalizedCurrency = currency.toLowerCase();
  if (normalizedCurrency.length === 0) {
    throw new RangeError("The entitlement hold currency is required");
  }
  const progressionRank = entitlementHoldProgressionRank(
    stripeReversalKind,
    status,
  );
  const effectiveActive = active && reversalAmount >= paymentAmount;
  const run = async (tx: PrismaTransaction) => {
    const hold = await tx.subscriptionEntitlementHold.upsert({
      where: {
        stripeReversalKind_stripeReversalId: {
          stripeReversalKind,
          stripeReversalId,
        },
      },
      create: {
        userId,
        stripeSubscriptionId,
        stripePaymentIntentId,
        stripeReversalKind,
        stripeReversalId,
        stripeInvoiceId,
        billingPeriodStart,
        billingPeriodEnd,
        paymentAmount,
        reversalAmount,
        currency: normalizedCurrency,
        status,
        active: effectiveActive,
        progressionRank,
        stripeEventId,
        stripeEventCreatedAt,
        stripeCanonicalObservedAt,
      },
      update: {},
    });
    if (
      hold.userId !== userId ||
      hold.stripeSubscriptionId !== stripeSubscriptionId ||
      hold.stripePaymentIntentId !== stripePaymentIntentId ||
      (hold.stripeInvoiceId !== null && hold.stripeInvoiceId !== stripeInvoiceId) ||
      (hold.paymentAmount !== null && hold.paymentAmount !== paymentAmount) ||
      (hold.currency !== null && hold.currency !== normalizedCurrency)
    ) {
      throw new Error(
        `Stripe ${stripeReversalKind} ${stripeReversalId} conflicts with its subscription hold`,
      );
    }

    const deactivateOtherInvoiceHolds = async () =>
      await tx.subscriptionEntitlementHold.updateMany({
        where: {
          userId,
          stripeSubscriptionId,
          // Every observation carries the canonical aggregate for the entire
          // invoice. Keep one active snapshot so a restoration on any one of
          // its PaymentIntents clears an earlier full-reversal snapshot.
          stripeInvoiceId,
          id: { not: hold.id },
          active: true,
        },
        data: { active: false },
      });
    const latestInvoiceHold = await tx.subscriptionEntitlementHold.findFirst({
      where: {
        userId,
        stripeSubscriptionId,
        stripeInvoiceId,
        stripeCanonicalObservedAt: { not: null },
      },
      orderBy: [
        { stripeCanonicalObservedAt: "desc" },
        { stripeEventCreatedAt: "desc" },
        { stripeEventId: "desc" },
      ],
    });
    if (
      latestInvoiceHold &&
      latestInvoiceHold.id !== hold.id &&
      compareEntitlementHoldCanonicalObservation(
        { stripeCanonicalObservedAt, stripeEventCreatedAt, stripeEventId },
        latestInvoiceHold,
      ) < 0
    ) {
      await tx.subscriptionEntitlementHold.updateMany({
        where: {
          id: hold.id,
          progressionRank: hold.progressionRank,
          stripeEventId: hold.stripeEventId,
          stripeEventCreatedAt: hold.stripeEventCreatedAt,
          stripeCanonicalObservedAt: hold.stripeCanonicalObservedAt,
          active: true,
        },
        data: { active: false },
      });
      return { applied: false, hold };
    }

    const rankDifference = progressionRank - hold.progressionRank;
    const canonicalDifference =
      stripeCanonicalObservedAt.getTime() -
      (hold.stripeCanonicalObservedAt?.getTime() ?? 0);
    const eventDifference =
      stripeEventCreatedAt.getTime() - hold.stripeEventCreatedAt.getTime();
    const isNewer =
      rankDifference > 0 ||
      (rankDifference === 0 &&
        (canonicalDifference > 0 ||
          (canonicalDifference === 0 &&
            (eventDifference > 0 ||
              (eventDifference === 0 && stripeEventId > hold.stripeEventId)))));
    if (!isNewer) {
      const isSameObservation =
        rankDifference === 0 &&
        canonicalDifference === 0 &&
        eventDifference === 0 &&
        stripeEventId === hold.stripeEventId &&
        hold.reversalAmount === reversalAmount &&
        hold.status === status &&
        hold.active === effectiveActive;
      if (isSameObservation) await deactivateOtherInvoiceHolds();
      return { applied: false, hold };
    }

    const updated = await tx.subscriptionEntitlementHold.updateMany({
      where: {
        id: hold.id,
        progressionRank: hold.progressionRank,
        stripeEventId: hold.stripeEventId,
        stripeEventCreatedAt: hold.stripeEventCreatedAt,
        stripeCanonicalObservedAt: hold.stripeCanonicalObservedAt,
      },
      data: {
        stripeInvoiceId,
        billingPeriodStart,
        billingPeriodEnd,
        paymentAmount,
        reversalAmount,
        currency: normalizedCurrency,
        status,
        active: effectiveActive,
        progressionRank,
        stripeEventId,
        stripeEventCreatedAt,
        stripeCanonicalObservedAt,
      },
    });
    if (updated.count !== 1) {
      throw new Error("Subscription entitlement hold changed concurrently");
    }
    await deactivateOtherInvoiceHolds();
    return {
      applied: true,
      hold: await tx.subscriptionEntitlementHold.findUnique({
        where: {
          stripeReversalKind_stripeReversalId: {
            stripeReversalKind,
            stripeReversalId,
          },
        },
      }),
    };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}
