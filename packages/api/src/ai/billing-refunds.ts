import type { BillingRefundAttempt } from "@prisma/client";
import {
  attachBillingRefundId,
  claimBillingRefundAttempt,
  findBillingRefundAttemptByPaymentIntentId,
  listDueBillingRefundAttempts,
  markBillingRefundInterventionRequired,
  markBillingRefundNoRefundRequired,
  recordBillingRefundCancellation,
  recordBillingRefundState,
  rescheduleBillingRefundAttempt,
  scheduleBillingRefundAttempt,
  startRetryableTransaction,
} from "@beutl/db";
import Stripe from "stripe";
import {
  getCanonicalPaymentRefundState,
  type CanonicalPaymentRefundState,
} from "./refund-state";

export const BILLING_REFUND_LEASE_MS = 10 * 60 * 1_000;
export const BILLING_REFUND_BASE_RETRY_MS = 5 * 60 * 1_000;
export const BILLING_REFUND_MAX_RETRY_MS = 6 * 60 * 60 * 1_000;
export const BILLING_REFUND_MAX_ATTEMPTS = 12;

const BILLING_REFUND_BATCH_SIZE = 25;
const MAX_ERROR_LENGTH = 2_000;

export type BillingRefundStripeClient = Pick<
  Stripe,
  | "invoicePayments"
  | "invoices"
  | "paymentIntents"
  | "refunds"
  | "subscriptions"
>;

export type BillingRefundProcessingResult = {
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

function expandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

function retryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return Math.min(
    BILLING_REFUND_BASE_RETRY_MS * 2 ** exponent,
    BILLING_REFUND_MAX_RETRY_MS,
  );
}

function managedRefunds(
  state: CanonicalPaymentRefundState,
  attemptId: string,
): Stripe.Refund[] {
  return state.refunds.filter(
    (refund) => refund.metadata?.billingRefundAttemptId === attemptId,
  );
}

function managedInterventionRefund(
  state: CanonicalPaymentRefundState,
  attemptId: string,
): Stripe.Refund | null {
  return managedRefunds(state, attemptId).find(
    (refund) =>
      refund.status === "failed" ||
      refund.status === "canceled" ||
      refund.status === "requires_action",
  ) ?? null;
}

async function deferOrEscalate({
  attempt,
  leaseToken,
  now,
  reason,
}: {
  attempt: BillingRefundAttempt;
  leaseToken: string;
  now: Date;
  reason: string;
}): Promise<AttemptOutcome> {
  if (attempt.attempts >= BILLING_REFUND_MAX_ATTEMPTS) {
    const marked = await markBillingRefundInterventionRequired({
      attemptId: attempt.id,
      leaseToken,
      now,
      reason,
    });
    return marked ? "intervention-required" : "lost";
  }
  const rescheduled = await rescheduleBillingRefundAttempt({
    attemptId: attempt.id,
    leaseToken,
    notBefore: new Date(now.getTime() + retryDelay(attempt.attempts)),
    lastError: reason,
  });
  return rescheduled ? "pending" : "lost";
}

async function persistCanonicalState({
  attempt,
  state,
  leaseToken,
  now,
}: {
  attempt: BillingRefundAttempt;
  state: CanonicalPaymentRefundState;
  leaseToken?: string;
  now: Date;
}): Promise<{ recorded: boolean; intervention: boolean }> {
  const latest = managedRefunds(state, attempt.id)[0] ?? null;
  const failed = managedInterventionRefund(state, attempt.id);
  const interventionReason = failed && !state.fullyRefunded
    ? `Stripe refund ${failed.id} reached ${failed.status ?? "unknown"}; an alternative refund method is required`
    : undefined;
  const recorded = await recordBillingRefundState({
    attemptId: attempt.id,
    stripePaymentIntentId: state.paymentIntent.id,
    targetAmount: state.targetAmount,
    succeededAmount: state.succeededAmount,
    pendingAmount: state.pendingAmount,
    currency: state.currency,
    refundId: latest?.id ?? null,
    refundStatus: latest?.status ?? null,
    observedAt: now,
    ...(leaseToken === undefined ? {} : { leaseToken }),
    ...(interventionReason === undefined ? {} : { interventionReason }),
  });
  return {
    recorded: recorded.count === 1,
    intervention: interventionReason !== undefined,
  };
}

async function ensureSubscriptionCanceled({
  stripe,
  attempt,
  leaseToken,
  now,
}: {
  stripe: BillingRefundStripeClient;
  attempt: BillingRefundAttempt;
  leaseToken: string;
  now: Date;
}): Promise<AttemptOutcome | null> {
  if (attempt.cancellationCompletedAt !== null) {
    return null;
  }
  let subscription = await stripe.subscriptions.retrieve(
    attempt.stripeSubscriptionId,
  );
  if (expandableId(subscription.customer) !== attempt.stripeCustomerId) {
    throw new Error(
      `Subscription ${subscription.id} customer does not match billing refund ${attempt.id}`,
    );
  }
  if (
    subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired"
  ) {
    subscription = await stripe.subscriptions.cancel(
      subscription.id,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey:
          `beutl:billing-refund-cancel:${attempt.sourceKey}`,
      },
    );
  }
  if (
    subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired"
  ) {
    return await deferOrEscalate({
      attempt,
      leaseToken,
      now,
      reason: `Subscription ${subscription.id} remains ${subscription.status}`,
    });
  }
  const recorded = await recordBillingRefundCancellation({
    attemptId: attempt.id,
    leaseToken,
    now,
  });
  return recorded ? null : "lost";
}

async function processClaimedAttempt({
  stripe,
  attempt,
  leaseToken,
  now,
}: {
  stripe: BillingRefundStripeClient;
  attempt: BillingRefundAttempt;
  leaseToken: string;
  now: Date;
}): Promise<AttemptOutcome> {
  const cancellationOutcome = await ensureSubscriptionCanceled({
    stripe,
    attempt,
    leaseToken,
    now,
  });
  if (cancellationOutcome !== null) {
    return cancellationOutcome;
  }
  if (attempt.stripePaymentIntentId === null) {
    const subscription = await stripe.subscriptions.retrieve(
      attempt.stripeSubscriptionId,
    );
    const stripeInvoiceId =
      attempt.stripeInvoiceId ?? expandableId(subscription.latest_invoice);
    const discoveredPaymentIntentIds = new Set<string>();
    if (stripeInvoiceId !== null) {
      let startingAfter: string | undefined;
      for (;;) {
        const payments = await stripe.invoicePayments.list({
          invoice: stripeInvoiceId,
          status: "paid",
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const payment of payments.data) {
          if ((payment.amount_paid ?? 0) <= 0) continue;
          const stripePaymentIntentId = expandableId(
            payment.payment.payment_intent,
          );
          if (!stripePaymentIntentId) {
            return await deferOrEscalate({
              attempt,
              leaseToken,
              now,
              reason: `Paid Invoice ${stripeInvoiceId} has a payment without a PaymentIntent`,
            });
          }
          discoveredPaymentIntentIds.add(stripePaymentIntentId);
        }
        if (!payments.has_more) break;
        const last = payments.data.at(-1);
        if (!last) {
          throw new Error(
            "Stripe returned an empty invoice-payment page with has_more",
          );
        }
        startingAfter = last.id;
      }
    }

    if (discoveredPaymentIntentIds.size > 0) {
      await startRetryableTransaction(async (tx) => {
        for (const stripePaymentIntentId of discoveredPaymentIntentIds) {
          await scheduleBillingRefundAttempt({
            disposition: attempt.disposition,
            sourceKey:
              `${attempt.stripeCheckoutSessionId}:${stripePaymentIntentId}`,
            stripeCustomerId: attempt.stripeCustomerId,
            stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
            stripeSubscriptionId: attempt.stripeSubscriptionId,
            stripeInvoiceId,
            stripePaymentIntentId,
            now,
            prisma: tx,
          });
        }
      });
    } else {
      if (stripeInvoiceId === null) {
        return await deferOrEscalate({
          attempt,
          leaseToken,
          now,
          reason:
            `Subscription ${attempt.stripeSubscriptionId} has no invoice proving payment settlement is terminal`,
        });
      }
      const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
      if (expandableId(invoice.customer) !== attempt.stripeCustomerId) {
        throw new Error(
          `Invoice ${invoice.id} customer does not match billing refund ${attempt.id}`,
        );
      }
      const noPaymentSettlementIsTerminal =
        invoice.amount_paid === 0 &&
        (invoice.status === "paid" || invoice.status === "void");
      if (!noPaymentSettlementIsTerminal) {
        return await deferOrEscalate({
          attempt,
          leaseToken,
          now,
          reason:
            `Invoice ${invoice.id} remains ${invoice.status ?? "unknown"} with ${invoice.amount_paid} paid units and no settled PaymentIntent`,
        });
      }
    }
    const marked = await markBillingRefundNoRefundRequired({
      attemptId: attempt.id,
      leaseToken,
      now,
    });
    return marked ? "no-refund-required" : "lost";
  }

  let state = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: attempt.stripePaymentIntentId,
  });
  if (expandableId(state.paymentIntent.customer) !== attempt.stripeCustomerId) {
    throw new Error(
      `PaymentIntent ${state.paymentIntent.id} customer does not match billing refund ${attempt.id}`,
    );
  }
  const firstObservation = await persistCanonicalState({
    attempt,
    state,
    leaseToken,
    now,
  });
  if (!firstObservation.recorded) return "lost";
  if (state.fullyRefunded) return "refunded";
  if (firstObservation.intervention) return "intervention-required";
  if (state.pendingAmount > 0) {
    return await deferOrEscalate({
      attempt,
      leaseToken,
      now,
      reason: `PaymentIntent ${state.paymentIntent.id} has ${state.pendingAmount} pending refund units`,
    });
  }
  if (state.refundableAmount <= 0) {
    throw new Error(
      `PaymentIntent ${state.paymentIntent.id} has no refundable remainder but is not fully refunded`,
    );
  }

  const refund = await stripe.refunds.create(
    {
      payment_intent: state.paymentIntent.id,
      amount: state.refundableAmount,
      metadata: {
        beutlDisposition: attempt.disposition,
        billingRefundAttemptId: attempt.id,
        checkoutSessionId: attempt.stripeCheckoutSessionId,
        subscriptionId: attempt.stripeSubscriptionId,
        refundTargetAmount: String(state.targetAmount),
        refundSucceededAmountBeforeCreate: String(state.succeededAmount),
      },
    },
    {
      idempotencyKey:
        `beutl:billing-refund:${attempt.id}:${state.succeededAmount}:${state.refundableAmount}`,
    },
  );
  if (!await attachBillingRefundId({
    attemptId: attempt.id,
    leaseToken,
    refundId: refund.id,
  })) {
    return "lost";
  }

  state = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: state.paymentIntent.id,
  });
  const observation = await persistCanonicalState({
    attempt: { ...attempt, refundId: refund.id },
    state,
    leaseToken,
    now,
  });
  if (!observation.recorded) return "lost";
  if (state.fullyRefunded) return "refunded";
  if (
    observation.intervention ||
    refund.status === "failed" ||
    refund.status === "canceled" ||
    refund.status === "requires_action"
  ) {
    const reason = `Stripe refund ${refund.id} reached ${refund.status ?? "unknown"}; an alternative refund method is required`;
    const marked = await markBillingRefundInterventionRequired({
      attemptId: attempt.id,
      leaseToken,
      now,
      reason,
    });
    return marked ? "intervention-required" : "lost";
  }
  return await deferOrEscalate({
    attempt,
    leaseToken,
    now,
    reason: `PaymentIntent ${state.paymentIntent.id} still has ${state.targetAmount - state.succeededAmount} refund units outstanding`,
  });
}

export async function processBillingRefunds({
  stripe,
  now = new Date(),
}: {
  stripe: BillingRefundStripeClient;
  now?: Date;
}): Promise<BillingRefundProcessingResult> {
  const due = await listDueBillingRefundAttempts({
    now,
    limit: BILLING_REFUND_BATCH_SIZE,
  });
  const result: BillingRefundProcessingResult = {
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
    const leaseToken = crypto.randomUUID();
    const claim = await claimBillingRefundAttempt({
      attemptId: candidate.id,
      now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + BILLING_REFUND_LEASE_MS),
      maxAttempts: BILLING_REFUND_MAX_ATTEMPTS,
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
        leaseToken,
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
        leaseToken,
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

export async function observeBillingRefundForPaymentIntent({
  stripe,
  stripePaymentIntentId,
  observedAt = new Date(),
}: {
  stripe: BillingRefundStripeClient;
  stripePaymentIntentId: string;
  observedAt?: Date;
}): Promise<boolean> {
  const attempt = await findBillingRefundAttemptByPaymentIntentId({
    stripePaymentIntentId,
  });
  if (!attempt) return false;
  const state = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId,
  });
  await persistCanonicalState({ attempt, state, now: observedAt });
  return true;
}

export async function reconcileBillingRefunds(
  now = new Date(),
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
): Promise<BillingRefundProcessingResult> {
  if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is required for billing refund processing");
  }
  const stripe = new Stripe(stripeSecretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
  return await processBillingRefunds({ stripe, now });
}
