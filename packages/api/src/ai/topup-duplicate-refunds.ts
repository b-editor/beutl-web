import Stripe from "stripe";
import { claimTopUpDuplicateRefundAttempts, completeTopUpDuplicateRefundAttempt, rescheduleTopUpDuplicateRefundAttempt, markTopUpDuplicateRefundIntervention } from "@beutl/db";

export async function reconcileTopUpDuplicateRefunds(now = new Date(), secretKey = process.env.STRIPE_SECRET_KEY, stripeClient?: Pick<Stripe, "paymentIntents" | "refunds">) {
  if (!stripeClient && !secretKey) return { inspected: 0, completed: 0, pending: 0, interventionRequired: 0 };
  const stripe = stripeClient ?? new Stripe(secretKey!);
  const leaseToken = crypto.randomUUID();
  const rows = await claimTopUpDuplicateRefundAttempts({ now, leaseToken, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000) });
  let completed = 0;
  let pending = 0;
  let interventionRequired = 0;
  for (const row of rows) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId, { expand: ["latest_charge"] });
      if (paymentIntent.status !== "succeeded" || paymentIntent.amount_received !== paymentIntent.amount) throw new Error("Top-up duplicate PaymentIntent is not fully captured");
      const customerId = typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer?.id;
      if (customerId !== row.stripeCustomerId || paymentIntent.metadata?.topUpAttemptId !== row.topUpAttemptId || paymentIntent.metadata?.beutlUserId !== row.ownerUserId || paymentIntent.metadata?.billingOfferId !== row.billingOfferId || paymentIntent.amount !== row.amount || paymentIntent.currency.toLowerCase() !== row.currency.toLowerCase()) throw new Error("Top-up duplicate refund identity mismatch");
      const allRefunds = []; let cursor: string | undefined;
      for (;;) { const page = await stripe.refunds.list({ payment_intent: row.stripePaymentIntentId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }); allRefunds.push(...page.data); if (!page.has_more) break; cursor = page.data.at(-1)?.id; if (!cursor) throw new Error("Stripe returned empty refund page"); }
      const refunded = allRefunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
      const nonTerminal = allRefunds.filter((refund) => refund.status !== "succeeded" && refund.status !== "failed" && refund.status !== "canceled");
      const reservedAmount = nonTerminal.reduce((sum, refund) => sum + refund.amount, 0);
      if (nonTerminal.length > 0) { await rescheduleTopUpDuplicateRefundAttempt({ id: row.id, leaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: `Stripe refund remains nonterminal (${reservedAmount} reserved)` }); pending++; continue; }
      if (refunded >= row.amount) {
        const settled = await completeTopUpDuplicateRefundAttempt({ id: row.id, leaseToken, refundId: allRefunds.find((refund) => refund.status === "succeeded")?.id ?? "already-refunded", refundedAmount: refunded });
        if (settled.count === 1) completed++;
        continue;
      }
      const failedRefunds = allRefunds.filter((refund) => refund.status === "failed" || refund.status === "canceled");
      const failedAmount = failedRefunds.reduce((sum, refund) => sum + refund.amount, 0);
      const refund = await stripe.refunds.create({ payment_intent: row.stripePaymentIntentId, amount: row.amount - refunded, metadata: { topUpDuplicateRefundAttemptId: row.id } }, { idempotencyKey: `top-up-duplicate-refund:${row.id}:${refunded}:${failedRefunds.length}:${failedAmount}` });
      if (refund.status === "succeeded") {
        const settled = await completeTopUpDuplicateRefundAttempt({ id: row.id, leaseToken, refundId: refund.id, refundedAmount: refunded + refund.amount });
        if (settled.count === 1) completed++;
      } else { await rescheduleTopUpDuplicateRefundAttempt({ id: row.id, leaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: `Refund status ${refund.status}` }); pending++; }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); if (row.attempts >= 12) { await markTopUpDuplicateRefundIntervention({ id: row.id, leaseToken, lastError: message }); interventionRequired++; } else { await rescheduleTopUpDuplicateRefundAttempt({ id: row.id, leaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: message }); pending++; } }
  }
  return { inspected: rows.length, completed, pending, interventionRequired };
}
