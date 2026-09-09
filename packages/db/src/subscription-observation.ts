// Stripe の契約観測を単調に保存するための純粋ヘルパー。CAS ループ本体は
// subscription.ts にあり、ここには比較と順位付けだけを置く。
export const MAX_OBSERVATION_CAS_ATTEMPTS = 8;

export const IRREVERSIBLE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

export type StripeSubscriptionObservation = {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  // プラン内の段階。ティアの無いプランでは null。省略は null と同じ。
  tier?: string | null;
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

export function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}

export function rankTimestamp(value: Date | null): string {
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

export function createSubscriptionObservationRank({
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

export function compareSubscriptionObservation(
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

