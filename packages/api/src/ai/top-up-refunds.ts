import type { TopUpCheckoutAttempt } from "@prisma/client";
import {
  attachTopUpRefundId,
  attachTopUpRefundPaymentIntent,
  claimTopUpRefundAttempt,
  findBillingOfferById,
  listDueTopUpRefundAttempts,
  markTopUpRefundInterventionRequired,
  markTopUpRefundNotRequired,
  recordTopUpRefund,
  rescheduleTopUpRefundAttempt,
} from "@beutl/db";
import {
  allowsStripePromotionCodes,
  isZeroCostStripeCheckoutSessionAmount,
} from "@beutl/core";
import Stripe from "stripe";
import {
  getCanonicalPaymentRefundState,
  type CanonicalPaymentRefundState,
} from "./refund-state";

export const TOP_UP_REFUND_LEASE_MS = 10 * 60 * 1_000;
export const TOP_UP_REFUND_BASE_RETRY_MS = 5 * 60 * 1_000;
export const TOP_UP_REFUND_MAX_RETRY_MS = 6 * 60 * 60 * 1_000;
export const TOP_UP_REFUND_MAX_ATTEMPTS = 12;

const TOP_UP_REFUND_BATCH_SIZE = 25;
const MAX_ERROR_LENGTH = 2_000;

export type TopUpRefundStripeClient = Pick<
  Stripe,
  "checkout" | "paymentIntents" | "refunds"
>;

export type TopUpRefundProcessingResult = {
  inspected: number;
  claimed: number;
  refunded: number;
  noRefundRequired: number;
  pending: number;
  errors: number;
  interventionRequired: number;
  skipped: number;
};

type AttemptOutcome =
  | "refunded"
  | "no-refund-required"
  | "pending"
  | "intervention-required"
  | "lost";

function expandableId(value: { id: string } | string | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function retryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return Math.min(
    TOP_UP_REFUND_BASE_RETRY_MS * 2 ** exponent,
    TOP_UP_REFUND_MAX_RETRY_MS,
  );
}

async function deferOrEscalate({
  attempt,
  refundLeaseToken,
  now,
  reason,
}: {
  attempt: TopUpCheckoutAttempt;
  refundLeaseToken: string;
  now: Date;
  reason: string;
}): Promise<AttemptOutcome> {
  if (attempt.refundAttempts >= TOP_UP_REFUND_MAX_ATTEMPTS) {
    const marked = await markTopUpRefundInterventionRequired({
      attemptId: attempt.id,
      refundLeaseToken,
      now,
      reason,
    });
    return marked ? "intervention-required" : "lost";
  }

  const rescheduled = await rescheduleTopUpRefundAttempt({
    attemptId: attempt.id,
    refundLeaseToken,
    refundNotBefore: new Date(now.getTime() + retryDelay(attempt.refundAttempts)),
    refundLastError: reason,
  });
  return rescheduled ? "pending" : "lost";
}

function assertStripeOwner(
  resourceName: string,
  actualCustomerId: string | null,
  expectedCustomerId: string,
): void {
  if (actualCustomerId !== expectedCustomerId) {
    throw new Error(
      `${resourceName} customer ${actualCustomerId ?? "<missing>"} does not match ${expectedCustomerId}`,
    );
  }
}

function managedTopUpRefunds(
  state: CanonicalPaymentRefundState,
  attemptId: string,
): Stripe.Refund[] {
  return state.refunds.filter(
    (refund) => refund.metadata?.topUpAttemptId === attemptId,
  );
}

async function recordCanonicalTopUpRefund({
  attempt,
  state,
  refundLeaseToken,
  now,
}: {
  attempt: TopUpCheckoutAttempt;
  state: CanonicalPaymentRefundState;
  refundLeaseToken: string;
  now: Date;
}): Promise<boolean> {
  const latest = managedTopUpRefunds(state, attempt.id)[0] ?? null;
  const recorded = await recordTopUpRefund({
    attemptId: attempt.id,
    stripePaymentIntentId: state.paymentIntent.id,
    refundId: latest?.id ?? null,
    refundStatus: latest?.status ?? null,
    refundTargetAmount: state.targetAmount,
    refundSucceededAmount: state.succeededAmount,
    refundPendingAmount: state.pendingAmount,
    refundCurrency: state.currency,
    now,
    refundLeaseToken,
  });
  return recorded.count === 1;
}

async function resolvePaymentIntent({
  stripe,
  attempt,
  refundLeaseToken,
  now,
}: {
  stripe: TopUpRefundStripeClient;
  attempt: TopUpCheckoutAttempt;
  refundLeaseToken: string;
  now: Date;
}): Promise<
  | { outcome: "resolved"; stripePaymentIntentId: string }
  | { outcome: AttemptOutcome }
> {
  if (attempt.stripePaymentIntentId !== null) {
    return {
      outcome: "resolved",
      stripePaymentIntentId: attempt.stripePaymentIntentId,
    };
  }
  if (attempt.stripeCheckoutSessionId === null) {
    throw new Error(
      `Top-up refund ${attempt.id} has neither a Checkout Session nor a PaymentIntent`,
    );
  }

  const session = await stripe.checkout.sessions.retrieve(
    attempt.stripeCheckoutSessionId,
    { expand: ["payment_intent", "line_items.data.price"] },
  );
  assertStripeOwner(
    `Checkout Session ${session.id}`,
    expandableId(session.customer),
    attempt.stripeCustomerId,
  );

  const stripePaymentIntentId = expandableId(session.payment_intent);
  if (stripePaymentIntentId !== null) {
    const attached = await attachTopUpRefundPaymentIntent({
      attemptId: attempt.id,
      stripePaymentIntentId,
      refundLeaseToken,
    });
    return attached
      ? { outcome: "resolved", stripePaymentIntentId }
      : { outcome: "lost" };
  }

  if (
    session.status === "complete" &&
    (session.payment_status === "paid" ||
      session.payment_status === "no_payment_required")
  ) {
    const offer = await findBillingOfferById({ id: attempt.billingOfferId });
    const lines = session.line_items?.data;
    const line = lines?.[0];
    const isOwnedZeroCostTopUp =
      offer?.kind === "top_up" &&
      Number.isSafeInteger(offer.creditAmount) &&
      (offer.creditAmount ?? 0) > 0 &&
      lines?.length === 1 &&
      line?.quantity === 1 &&
      expandableId(line.price) === offer.stripePriceId &&
      session.mode === "payment" &&
      session.metadata?.beutlApplication === "beutl-web" &&
      session.metadata?.beutlUserId === attempt.ownerUserId &&
      session.metadata?.topUpAttemptId === attempt.id &&
      session.metadata?.billingOfferId === attempt.billingOfferId &&
      session.metadata?.creditAmount === String(offer.creditAmount) &&
      session.currency?.toLowerCase() === offer.currency.toLowerCase() &&
      isZeroCostStripeCheckoutSessionAmount(
        {
          amountSubtotal: session.amount_subtotal,
          amountTotal: session.amount_total,
        },
        offer.unitAmount,
        allowsStripePromotionCodes(attempt.paramsJson),
      );
    if (isOwnedZeroCostTopUp) {
      const marked = await markTopUpRefundNotRequired({
        attemptId: attempt.id,
        refundLeaseToken,
        now,
      });
      return { outcome: marked ? "no-refund-required" : "lost" };
    }
  }

  const canCloseWithoutRefund =
    attempt.status === "refund_required" &&
    attempt.accountDeletionAt !== null &&
    session.payment_status === "unpaid";
  if (!canCloseWithoutRefund) {
    return {
      outcome: await deferOrEscalate({
        attempt,
        refundLeaseToken,
        now,
        reason: `Checkout Session ${session.id} has no PaymentIntent and is ${session.status ?? "unknown"}/${session.payment_status}`,
      }),
    };
  }

  if (session.status === "open") {
    const expired = await stripe.checkout.sessions.expire(session.id, {
      idempotencyKey: `beutl:ai-top-up-expire:${attempt.id}`,
    });
    if (
      expired.status !== "expired" ||
      expired.payment_status !== "unpaid" ||
      expandableId(expired.payment_intent) !== null
    ) {
      return {
        outcome: await deferOrEscalate({
          attempt,
          refundLeaseToken,
          now,
          reason: `Checkout Session ${session.id} changed while expiring`,
        }),
      };
    }
  } else if (session.status !== "expired") {
    return {
      outcome: await deferOrEscalate({
        attempt,
        refundLeaseToken,
        now,
        reason: `Unpaid Checkout Session ${session.id} is ${session.status ?? "unknown"}`,
      }),
    };
  }

  const marked = await markTopUpRefundNotRequired({
    attemptId: attempt.id,
    refundLeaseToken,
    now,
  });
  return { outcome: marked ? "no-refund-required" : "lost" };
}

async function processClaimedAttempt({
  stripe,
  attempt,
  refundLeaseToken,
  now,
}: {
  stripe: TopUpRefundStripeClient;
  attempt: TopUpCheckoutAttempt;
  refundLeaseToken: string;
  now: Date;
}): Promise<AttemptOutcome> {
  const resolution = await resolvePaymentIntent({
    stripe,
    attempt,
    refundLeaseToken,
    now,
  });
  if (resolution.outcome !== "resolved") {
    return resolution.outcome;
  }

  let state = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: resolution.stripePaymentIntentId,
  });
  const paymentIntent = state.paymentIntent;
  assertStripeOwner(
    `PaymentIntent ${paymentIntent.id}`,
    expandableId(paymentIntent.customer),
    attempt.stripeCustomerId,
  );
  if (paymentIntent.status !== "succeeded") {
    return await deferOrEscalate({
      attempt: {
        ...attempt,
        stripePaymentIntentId: paymentIntent.id,
      },
      refundLeaseToken,
      now,
      reason: `PaymentIntent ${paymentIntent.id} is ${paymentIntent.status}`,
    });
  }

  if (!await recordCanonicalTopUpRefund({
    attempt: { ...attempt, stripePaymentIntentId: paymentIntent.id },
    state,
    refundLeaseToken,
    now,
  })) {
    return "lost";
  }
  if (state.fullyRefunded) {
    return "refunded";
  }

  const managedRefunds = managedTopUpRefunds(state, attempt.id);
  const failed = managedRefunds.find(
    (refund) =>
      refund.status === "failed" ||
      refund.status === "canceled" ||
      refund.status === "requires_action",
  );
  if (failed) {
    const reason = `Stripe refund ${failed.id} reached ${failed.status ?? "unknown"}; an alternative refund method is required`;
    const marked = await markTopUpRefundInterventionRequired({
      attemptId: attempt.id,
      refundLeaseToken,
      now,
      reason,
    });
    return marked ? "intervention-required" : "lost";
  }

  if (state.pendingAmount > 0) {
    return await deferOrEscalate({
      attempt,
      refundLeaseToken,
      now,
      reason: `PaymentIntent ${paymentIntent.id} has ${state.pendingAmount} pending refund units`,
    });
  }

  if (state.refundableAmount <= 0) {
    throw new Error(
      `PaymentIntent ${paymentIntent.id} has no refundable remainder but is not fully refunded`,
    );
  }

  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntent.id,
      amount: state.refundableAmount,
      metadata: {
        beutlDisposition: "unfulfillable-ai-top-up",
        topUpAttemptId: attempt.id,
        refundTargetAmount: String(state.targetAmount),
        refundSucceededAmountBeforeCreate: String(state.succeededAmount),
      },
    },
    {
      idempotencyKey:
        `beutl:ai-top-up-refund:${attempt.id}:${state.succeededAmount}:${state.refundableAmount}`,
    },
  );
  const attached = await attachTopUpRefundId({
    attemptId: attempt.id,
    stripePaymentIntentId: paymentIntent.id,
    refundId: refund.id,
    refundLeaseToken,
  });
  if (!attached) {
    return "lost";
  }

  state = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: paymentIntent.id,
  });
  if (!await recordCanonicalTopUpRefund({
    attempt: {
      ...attempt,
      stripePaymentIntentId: paymentIntent.id,
      refundId: refund.id,
    },
    state,
    refundLeaseToken,
    now,
  })) {
    return "lost";
  }
  if (state.fullyRefunded) {
    return "refunded";
  }
  if (refund.status === "failed" || refund.status === "canceled" ||
    refund.status === "requires_action") {
    const reason = `Stripe refund ${refund.id} reached ${refund.status}; an alternative refund method is required`;
    const marked = await markTopUpRefundInterventionRequired({
      attemptId: attempt.id,
      refundLeaseToken,
      now,
      reason,
    });
    return marked ? "intervention-required" : "lost";
  }
  return await deferOrEscalate({
    attempt,
    refundLeaseToken,
    now,
    reason: `PaymentIntent ${paymentIntent.id} still has ${state.targetAmount - state.succeededAmount} refund units outstanding`,
  });
}

export async function processTopUpRefunds({
  stripe,
  now = new Date(),
}: {
  stripe: TopUpRefundStripeClient;
  now?: Date;
}): Promise<TopUpRefundProcessingResult> {
  const due = await listDueTopUpRefundAttempts({
    now,
    limit: TOP_UP_REFUND_BATCH_SIZE,
  });
  const result: TopUpRefundProcessingResult = {
    inspected: due.length,
    claimed: 0,
    refunded: 0,
    noRefundRequired: 0,
    pending: 0,
    errors: 0,
    interventionRequired: 0,
    skipped: 0,
  };

  for (const candidate of due) {
    const refundLeaseToken = crypto.randomUUID();
    const claim = await claimTopUpRefundAttempt({
      attemptId: candidate.id,
      now,
      leaseToken: refundLeaseToken,
      leaseExpiresAt: new Date(now.getTime() + TOP_UP_REFUND_LEASE_MS),
      maxAttempts: TOP_UP_REFUND_MAX_ATTEMPTS,
    });
    if (claim.outcome === "not-claimed") {
      result.skipped++;
      continue;
    }
    if (claim.outcome === "intervention-required") {
      result.interventionRequired++;
      continue;
    }

    result.claimed++;
    try {
      const outcome = await processClaimedAttempt({
        stripe,
        attempt: claim.attempt,
        refundLeaseToken,
        now,
      });
      if (outcome === "refunded") result.refunded++;
      else if (outcome === "no-refund-required") result.noRefundRequired++;
      else if (outcome === "pending") result.pending++;
      else if (outcome === "intervention-required") {
        result.interventionRequired++;
      } else result.skipped++;
    } catch (error) {
      result.errors++;
      const outcome = await deferOrEscalate({
        attempt: claim.attempt,
        refundLeaseToken,
        now,
        reason: errorMessage(error),
      });
      if (outcome === "intervention-required") {
        result.interventionRequired++;
      } else if (outcome === "pending") {
        result.pending++;
      } else {
        result.skipped++;
      }
    }
  }

  return result;
}

export async function reconcileTopUpRefunds(
  now = new Date(),
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
): Promise<TopUpRefundProcessingResult> {
  if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is required for top-up refund processing");
  }
  const stripe = new Stripe(stripeSecretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
  return await processTopUpRefunds({ stripe, now });
}
