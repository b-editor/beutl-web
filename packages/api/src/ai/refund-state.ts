import Stripe from "stripe";

export type RefundStateStripeClient = Pick<
  Stripe,
  "paymentIntents" | "refunds"
>;

export type CanonicalPaymentRefundState = {
  paymentIntent: Stripe.PaymentIntent;
  refunds: Stripe.Refund[];
  targetAmount: number;
  succeededAmount: number;
  pendingAmount: number;
  refundableAmount: number;
  currency: string;
  fullyRefunded: boolean;
};

function expandableId(
  value: string | { id: string } | null,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function assertMoneyAmount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

async function listAllRefunds(
  stripe: RefundStateStripeClient,
  stripePaymentIntentId: string,
): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.refunds.list({
      payment_intent: stripePaymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const refund of page.data) {
      if (seen.has(refund.id)) {
        throw new Error(`Stripe repeated refund ${refund.id} while paginating`);
      }
      seen.add(refund.id);
      refunds.push(refund);
    }
    if (!page.has_more) {
      return refunds;
    }
    const last = page.data.at(-1);
    if (!last) {
      throw new Error("Stripe returned an empty refund page with has_more");
    }
    startingAfter = last.id;
  }
}

export async function getCanonicalPaymentRefundState({
  stripe,
  stripePaymentIntentId,
}: {
  stripe: RefundStateStripeClient;
  stripePaymentIntentId: string;
}): Promise<CanonicalPaymentRefundState> {
  const [paymentIntent, refunds] = await Promise.all([
    stripe.paymentIntents.retrieve(stripePaymentIntentId),
    listAllRefunds(stripe, stripePaymentIntentId),
  ]);
  const targetAmount = paymentIntent.amount_received;
  assertMoneyAmount(targetAmount, `PaymentIntent ${paymentIntent.id} amount_received`);
  const currency = paymentIntent.currency.toLowerCase();
  let succeededAmount = 0;
  let pendingAmount = 0;

  for (const refund of refunds) {
    const refundPaymentIntentId = expandableId(refund.payment_intent);
    if (
      refundPaymentIntentId !== null &&
      refundPaymentIntentId !== paymentIntent.id
    ) {
      throw new Error(
        `Stripe refund ${refund.id} belongs to PaymentIntent ${refundPaymentIntentId}`,
      );
    }
    assertMoneyAmount(refund.amount, `Refund ${refund.id} amount`);
    if (refund.currency.toLowerCase() !== currency) {
      throw new Error(
        `Stripe refund ${refund.id} currency does not match PaymentIntent ${paymentIntent.id}`,
      );
    }

    if (refund.status === "succeeded") {
      succeededAmount += refund.amount;
    } else if (refund.status !== "failed" && refund.status !== "canceled") {
      // pending, requires_action, and unknown transitional states reserve the
      // amount so another worker cannot issue an overlapping refund.
      pendingAmount += refund.amount;
    }
  }

  assertMoneyAmount(succeededAmount, "aggregate succeeded refund amount");
  assertMoneyAmount(pendingAmount, "aggregate pending refund amount");
  if (succeededAmount + pendingAmount > targetAmount) {
    throw new Error(
      `Stripe refunds exceed PaymentIntent ${paymentIntent.id} amount_received`,
    );
  }

  return {
    paymentIntent,
    refunds,
    targetAmount,
    succeededAmount,
    pendingAmount,
    refundableAmount: targetAmount - succeededAmount - pendingAmount,
    currency,
    fullyRefunded: targetAmount > 0 && succeededAmount === targetAmount,
  };
}
