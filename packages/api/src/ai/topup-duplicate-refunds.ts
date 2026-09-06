import {
  claimTopUpDuplicateRefundAttempts,
  completeTopUpDuplicateRefundAttempt,
  markTopUpDuplicateRefundIntervention,
  rescheduleTopUpDuplicateRefundAttempt,
  resumeSettledTopUpCheckoutInterventions,
  type ClaimedTopUpDuplicateRefund,
} from "@beutl/db";
import Stripe from "stripe";

export const TOP_UP_DUPLICATE_REFUND_MAX_ATTEMPTS = 12;
const RETRY_DELAY_MS = 5 * 60_000;
const INTERVENTION_RECHECK_MS = 6 * 60 * 60_000;
const LEASE_MS = 10 * 60_000;

function refundIsTerminalFailure(refund: Stripe.Refund): boolean {
  return refund.status === "failed" || refund.status === "canceled";
}

export async function reconcileTopUpDuplicateRefunds(
  now = new Date(),
  secretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient?: Pick<Stripe, "paymentIntents" | "refunds">,
) {
  if (!stripeClient && !secretKey) {
    return {
      inspected: 0,
      completed: 0,
      pending: 0,
      interventionRequired: 0,
    };
  }
  const stripe = stripeClient ?? new Stripe(secretKey!);
  const leaseToken = crypto.randomUUID();
  const rows = await claimTopUpDuplicateRefundAttempts({
    now,
    leaseToken,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
  });
  let completed = 0;
  let pending = 0;
  let interventionRequired = 0;

  for (const row of rows) {
    const defer = async (message: string) => {
      if (
        row.claimKind === "canonical-recheck" ||
        row.attempts >= TOP_UP_DUPLICATE_REFUND_MAX_ATTEMPTS
      ) {
        const marked = await markTopUpDuplicateRefundIntervention({
          id: row.id,
          leaseToken,
          interventionAt: row.interventionAt ?? now,
          nextCanonicalCheckAt: new Date(
            now.getTime() + INTERVENTION_RECHECK_MS,
          ),
          lastError: message,
          observedAt: now,
        });
        if (marked.count === 1) interventionRequired++;
      } else {
        const rescheduled = await rescheduleTopUpDuplicateRefundAttempt({
          id: row.id,
          leaseToken,
          notBefore: new Date(now.getTime() + RETRY_DELAY_MS),
          lastError: message,
          observedAt: now,
        });
        if (rescheduled.count === 1) pending++;
      }
    };

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        row.stripePaymentIntentId,
        { expand: ["latest_charge"] },
      );
      const customerId = typeof paymentIntent.customer === "string"
        ? paymentIntent.customer
        : paymentIntent.customer?.id;
      if (
        paymentIntent.status !== "succeeded" ||
        paymentIntent.amount_received !== paymentIntent.amount ||
        customerId !== row.stripeCustomerId ||
        paymentIntent.metadata?.topUpAttemptId !== row.topUpAttemptId ||
        paymentIntent.metadata?.beutlUserId !== row.ownerUserId ||
        paymentIntent.metadata?.billingOfferId !== row.billingOfferId ||
        paymentIntent.amount !== row.amount ||
        paymentIntent.currency.toLowerCase() !== row.currency.toLowerCase()
      ) {
        throw new Error("Top-up duplicate refund identity mismatch");
      }

      const refunds: Stripe.Refund[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await stripe.refunds.list({
          payment_intent: row.stripePaymentIntentId,
          limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
        });
        refunds.push(...page.data);
        if (!page.has_more) break;
        cursor = page.data.at(-1)?.id;
        if (!cursor) {
          throw new Error("Stripe returned an empty refund page with has_more");
        }
      }

      const succeeded = refunds.filter((refund) =>
        refund.status === "succeeded");
      const refundedAmount = succeeded.reduce(
        (total, refund) => total + refund.amount,
        0,
      );
      if (refundedAmount >= row.amount) {
        const settled = await completeTopUpDuplicateRefundAttempt({
          id: row.id,
          leaseToken,
          refundId: succeeded[0]?.id ?? "already-refunded",
          refundedAmount: row.amount,
          observedAt: now,
        });
        if (settled.count === 1) completed++;
        continue;
      }

      const nonTerminal = refunds.filter((refund) =>
        refund.status !== "succeeded" && !refundIsTerminalFailure(refund));
      if (nonTerminal.length > 0) {
        const reservedAmount = nonTerminal.reduce(
          (total, refund) => total + refund.amount,
          0,
        );
        await defer(
          `Stripe refund remains nonterminal (${reservedAmount} reserved)`,
        );
        continue;
      }

      if (row.claimKind === "canonical-recheck") {
        await defer("Canonical Stripe recheck still requires operator action");
        continue;
      }
      if (row.attempts >= TOP_UP_DUPLICATE_REFUND_MAX_ATTEMPTS) {
        await defer(
          `Automatic duplicate refund exhausted ${TOP_UP_DUPLICATE_REFUND_MAX_ATTEMPTS} attempts`,
        );
        continue;
      }

      const failed = refunds.filter(refundIsTerminalFailure);
      const failedAmount = failed.reduce(
        (total, refund) => total + refund.amount,
        0,
      );
      const refund = await stripe.refunds.create(
        {
          payment_intent: row.stripePaymentIntentId,
          amount: row.amount - refundedAmount,
          metadata: { topUpDuplicateRefundAttemptId: row.id },
        },
        {
          idempotencyKey:
            `top-up-duplicate-refund:${row.id}:${refundedAmount}:${failed.length}:${failedAmount}`,
        },
      );
      if (refund.status === "succeeded") {
        const settled = await completeTopUpDuplicateRefundAttempt({
          id: row.id,
          leaseToken,
          refundId: refund.id,
          refundedAmount: Math.min(
            row.amount,
            refundedAmount + refund.amount,
          ),
          observedAt: now,
        });
        if (settled.count === 1) completed++;
      } else {
        await defer(`Stripe refund remains ${refund.status ?? "unknown"}`);
      }
    } catch (error) {
      await defer(error instanceof Error ? error.message : String(error));
    }
  }

  await resumeSettledTopUpCheckoutInterventions({ now });
  return { inspected: rows.length, completed, pending, interventionRequired };
}
