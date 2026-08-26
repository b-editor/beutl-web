import Stripe from "stripe";
import {
  claimPackagePaymentRefundAttempt,
  completePackagePaymentRefundAttempt,
  listDuePackagePaymentRefundAttempts,
  markPackagePaymentRefundIntervention,
  reschedulePackagePaymentRefundAttempt,
} from "@beutl/db";

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

export type PackagePaymentRefundReconcileResult = {
  inspected: number;
  claimed: number;
  refunded: number;
  pending: number;
  interventionRequired: number;
};

function delay(attempts: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 6), MAX_RETRY_MS);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export async function reconcilePackagePaymentRefunds(
  now = new Date(),
  secretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient?: Pick<Stripe, "paymentIntents" | "refunds">,
): Promise<PackagePaymentRefundReconcileResult> {
  if (!stripeClient && !secretKey) {
    return { inspected: 0, claimed: 0, refunded: 0, pending: 0, interventionRequired: 0 };
  }
  const stripe = stripeClient ?? new Stripe(secretKey!);
  const due = await listDuePackagePaymentRefundAttempts({ now });
  const result: PackagePaymentRefundReconcileResult = {
    inspected: due.length,
    claimed: 0,
    refunded: 0,
    pending: 0,
    interventionRequired: 0,
  };
  for (const candidate of due) {
    const leaseToken = crypto.randomUUID();
    const claimed = await claimPackagePaymentRefundAttempt({
      id: candidate.id,
      now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    });
    if (!claimed) continue;
    result.claimed++;
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(claimed.paymentIntentId);
      if (
        paymentIntent.metadata.beutlPurchaseKind !== "package" ||
        paymentIntent.status !== "succeeded" ||
        paymentIntent.amount_received !== paymentIntent.amount ||
        paymentIntent.amount !== claimed.amount ||
        paymentIntent.currency.toLowerCase() !== claimed.currency.toLowerCase() ||
        !paymentIntent.customer ||
        (claimed.userId && paymentIntent.metadata.beutlUserId !== claimed.userId) ||
        (claimed.packageId && paymentIntent.metadata.packageId !== claimed.packageId) ||
        (claimed.customerId && (typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer.id) !== claimed.customerId)
      ) {
        throw new Error("Package payment refund canonical identity mismatch");
      }
      const refunds: Stripe.Refund[] = [];
      let refundCursor: string | undefined;
      for (;;) {
        const page = await stripe.refunds.list({ payment_intent: claimed.paymentIntentId, limit: 100, ...(refundCursor ? { starting_after: refundCursor } : {}) });
        refunds.push(...page.data);
        if (!page.has_more) break;
        refundCursor = page.data.at(-1)?.id;
        if (!refundCursor) throw new Error("Stripe returned an empty refund page with has_more");
      }
      const succeededAmount = refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
      const nonTerminalAmount = refunds.filter((refund) => refund.status !== "succeeded" && refund.status !== "failed" && refund.status !== "canceled").reduce((sum, refund) => sum + refund.amount, 0);
      if (succeededAmount >= claimed.amount) {
        if ((await completePackagePaymentRefundAttempt({ id: claimed.id, leaseToken })).count !== 1) throw new Error("Package refund lease lost");
        result.refunded++;
        continue;
      }
      const nonTerminalRefunds = refunds.filter((refund) => refund.status !== "succeeded" && refund.status !== "failed" && refund.status !== "canceled");
      if (nonTerminalRefunds.length > 0) {
        await reschedulePackagePaymentRefundAttempt({ id: claimed.id, leaseToken, notBefore: new Date(now.getTime() + delay(claimed.attempts)), lastError: `Stripe refund remains nonterminal (${nonTerminalAmount} reserved)` });
        result.pending++;
        continue;
      }
      const failedRefunds = refunds.filter((refund) => refund.status === "failed" || refund.status === "canceled");
      const failedAmount = failedRefunds.reduce((sum, refund) => sum + refund.amount, 0);
      const refund = await stripe.refunds.create(
        { payment_intent: claimed.paymentIntentId, amount: claimed.amount - succeededAmount, metadata: { packagePaymentRefundAttemptId: claimed.id } },
        { idempotencyKey: `beutl:package-payment-refund:${claimed.id}:${succeededAmount}:${failedRefunds.length}:${failedAmount}` },
      );
      if (refund.status === "succeeded") {
        if ((await completePackagePaymentRefundAttempt({ id: claimed.id, leaseToken })).count !== 1) throw new Error("Package refund lease lost");
        result.refunded++;
      } else {
        await reschedulePackagePaymentRefundAttempt({
          id: claimed.id,
          leaseToken,
          notBefore: new Date(now.getTime() + delay(claimed.attempts)),
          lastError: `Stripe refund remains ${refund.status ?? "unknown"}`,
        });
        result.pending++;
      }
    } catch (error) {
      if (claimed.attempts >= MAX_ATTEMPTS) {
        await markPackagePaymentRefundIntervention({ id: claimed.id, leaseToken, lastError: message(error) });
        result.interventionRequired++;
      } else {
        await reschedulePackagePaymentRefundAttempt({
          id: claimed.id,
          leaseToken,
          notBefore: new Date(now.getTime() + delay(claimed.attempts)),
          lastError: message(error),
        });
        result.pending++;
      }
    }
  }
  return result;
}
