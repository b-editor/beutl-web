// Plan-agnostic pieces of the Stripe subscription webhook, shared by the AI
// Pro handler (the webhook route) and the storage plan handler. Moved here
// verbatim from the route module, which may export only HTTP handlers.
import { getCanonicalPaymentRefundState } from "@beutl/api";
import { findCustomerByStripeId } from "@beutl/db";
import type Stripe from "stripe";
import type { createStripe } from "./config";
import { isStripeResourceMissingError } from "./errors";
import {
  getExpandableId,
  getStripeCustomerOwnershipProof,
  type StripeCustomerOwnershipRecord,
} from "./ownership";

export type VersionedInvoice = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
};

export type StripeClient = ReturnType<typeof createStripe>;

export type StripeEventObservation = Pick<Stripe.Event, "id" | "created">;

export function stripeEventCreatedAt(event: StripeEventObservation): Date {
  if (!Number.isSafeInteger(event.created) || event.created < 0) {
    throw new RangeError(`Stripe event ${event.id} has an invalid created time`);
  }
  return new Date(event.created * 1000);
}

export function subscriptionCreatedAt(
  subscription: Stripe.Subscription,
): Date | null {
  return subscription.created
    ? new Date(subscription.created * 1000)
    : null;
}

export const ACTIVE_DISPUTE_STATUSES = new Set<Stripe.Dispute.Status>([
  "needs_response",
  "under_review",
  "lost",
]);

export function getInvoiceSubscription(
  invoice: VersionedInvoice,
): string | Stripe.Subscription | null {
  return (
    invoice.parent?.subscription_details?.subscription ??
    invoice.subscription ??
    null
  );
}

export function subscriptionRank(
  subscription: Stripe.Subscription,
  recognizedProOffer: boolean,
): [number, number, number] {
  const expectedPrice = recognizedProOffer ? 1 : 0;
  const nonTerminal = isTerminalSubscriptionStatus(subscription.status) ? 0 : 1;
  return [expectedPrice, nonTerminal, subscription.created ?? 0];
}

export function isTerminalSubscriptionStatus(status: string): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

// `refund.*` events do not carry the customer, so resolve it from the payment
// intent (preferred) or the charge before reconciling the subscription.
export async function resolveRefundCustomerId(
  stripe: StripeClient,
  eventRefund: Stripe.Refund,
): Promise<string | null> {
  // The event payload is a snapshot and may omit the links we need, so resolve
  // the canonical refund before walking to the payment intent or charge.
  const refund = await stripe.refunds.retrieve(eventRefund.id);
  const paymentIntentId = getExpandableId(refund.payment_intent);
  if (paymentIntentId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const customerId = getExpandableId(paymentIntent.customer);
    if (customerId) {
      return customerId;
    }
  }

  const chargeId = getExpandableId(refund.charge);
  if (!chargeId) {
    return null;
  }
  const charge = await stripe.charges.retrieve(chargeId);
  return getExpandableId(charge.customer);
}

export function compareSubscriptionRank(
  left: Stripe.Subscription,
  right: Stripe.Subscription,
  leftIsRecognized: boolean,
  rightIsRecognized: boolean,
): number {
  const leftRank = subscriptionRank(left, leftIsRecognized);
  const rightRank = subscriptionRank(right, rightIsRecognized);
  for (let index = 0; index < leftRank.length; index++) {
    const difference = leftRank[index] - rightRank[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function retrieveSubscriptionForWebhookEvent(
  stripe: StripeClient,
  stripeSubscriptionId: string,
  event: Stripe.Event,
): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(stripeSubscriptionId);
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      // Webhooks can be delivered after a cancellation or local account
      // deletion. Stripe retries non-2xx responses, but no remaining local
      // state can be reconciled from an object Stripe has permanently removed.
      console.warn("Acknowledging a Stripe event for a removed subscription", {
        eventId: event.id,
        eventType: event.type,
        stripeSubscriptionId,
      });
      return null;
    }
    throw error;
  }
}

export function isOwnedSubscription(
  subscription: Stripe.Subscription,
  customerId: string,
  userId: string,
  ownership: StripeCustomerOwnershipRecord | null | undefined,
): boolean {
  return (
    getExpandableId(subscription.customer) === customerId &&
    getStripeCustomerOwnershipProof({
      customerId,
      metadata: subscription.metadata,
      ownership,
      userId,
    }) !== "mismatch"
  );
}

export type StripeListPage<T> = {
  data: T[];
  has_more: boolean;
};

export async function listAllStripeObjects<T extends { id: string }>(
  resourceName: string,
  listPage: (startingAfter?: string) => Promise<StripeListPage<T>>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await listPage(startingAfter);
    for (const item of page.data) {
      if (seen.has(item.id)) {
        throw new Error(
          `Stripe repeated ${resourceName} ${item.id} while paginating`,
        );
      }
      seen.add(item.id);
      result.push(item);
    }
    if (!page.has_more) return result;
    const last = page.data.at(-1);
    if (!last) {
      throw new Error(
        `Stripe returned an empty ${resourceName} page with has_more`,
      );
    }
    startingAfter = last.id;
  }
}

export async function listAllInvoicePayments(
  stripe: StripeClient,
  params: Omit<
    Stripe.InvoicePaymentListParams,
    "ending_before" | "limit" | "starting_after"
  >,
): Promise<Stripe.InvoicePayment[]> {
  return await listAllStripeObjects("invoice payment", async (startingAfter) =>
    await stripe.invoicePayments.list({
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
}

export async function listAllPaymentIntentCharges(
  stripe: StripeClient,
  stripePaymentIntentId: string,
): Promise<Stripe.Charge[]> {
  return await listAllStripeObjects("charge", async (startingAfter) =>
    await stripe.charges.list({
      payment_intent: stripePaymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
}

export async function listAllChargeDisputes(
  stripe: StripeClient,
  stripeChargeId: string,
): Promise<Stripe.Dispute[]> {
  return await listAllStripeObjects("dispute", async (startingAfter) =>
    await stripe.disputes.list({
      charge: stripeChargeId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
}

export function assertMoneyAmount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function addMoneyAmount(total: number, amount: number, name: string): number {
  assertMoneyAmount(amount, name);
  const result = total + amount;
  assertMoneyAmount(result, `aggregate ${name}`);
  return result;
}

export async function getActivePaymentIntentDisputeAmount({
  stripe,
  paymentIntent,
  customerId,
  currency,
}: {
  stripe: StripeClient;
  paymentIntent: Stripe.PaymentIntent;
  customerId: string;
  currency: string;
}): Promise<number | null> {
  const charges = await listAllPaymentIntentCharges(stripe, paymentIntent.id);
  let activeDisputeAmount = 0;
  for (const charge of charges) {
    if (
      getExpandableId(charge.payment_intent) !== paymentIntent.id ||
      getExpandableId(charge.customer) !== customerId ||
      charge.currency.toLowerCase() !== currency
    ) {
      return null;
    }
    const disputes = await listAllChargeDisputes(stripe, charge.id);
    for (const dispute of disputes) {
      if (
        getExpandableId(dispute.charge) !== charge.id ||
        getExpandableId(dispute.payment_intent) !== paymentIntent.id ||
        dispute.currency.toLowerCase() !== currency
      ) {
        return null;
      }
      assertMoneyAmount(dispute.amount, `Dispute ${dispute.id} amount`);
      if (ACTIVE_DISPUTE_STATUSES.has(dispute.status)) {
        activeDisputeAmount = addMoneyAmount(
          activeDisputeAmount,
          dispute.amount,
          "active dispute amount",
        );
      }
    }
  }
  if (activeDisputeAmount > paymentIntent.amount_received) {
    throw new Error(
      `Stripe disputes exceed PaymentIntent ${paymentIntent.id} amount_received`,
    );
  }
  return activeDisputeAmount;
}

export async function resolveCanonicalInvoiceReversalTotals({
  stripe,
  invoice,
  stripePaymentIntentId,
  customerId,
}: {
  stripe: StripeClient;
  invoice: Stripe.Invoice;
  stripePaymentIntentId: string;
  customerId: string;
}): Promise<{
  paymentAmount: number;
  reversalAmount: number;
  currency: string;
} | null> {
  const currency = invoice.currency.toLowerCase();
  assertMoneyAmount(invoice.amount_paid, `Invoice ${invoice.id} amount_paid`);
  if (
    invoice.status !== "paid" ||
    invoice.amount_paid <= 0 ||
    currency.length === 0 ||
    getExpandableId(invoice.customer) !== customerId
  ) {
    return null;
  }

  const invoicePayments = await listAllInvoicePayments(stripe, {
    invoice: invoice.id,
    status: "paid",
  });
  const allocatedByPaymentIntent = new Map<string, number>();
  let paymentAmount = 0;
  for (const invoicePayment of invoicePayments) {
    const invoicePaymentIntentId = getExpandableId(
      invoicePayment.payment.payment_intent,
    );
    if (
      invoicePayment.status !== "paid" ||
      getExpandableId(invoicePayment.invoice) !== invoice.id ||
      invoicePayment.currency.toLowerCase() !== currency ||
      invoicePayment.payment.type !== "payment_intent" ||
      !invoicePaymentIntentId ||
      invoicePayment.amount_paid === null ||
      invoicePayment.amount_paid <= 0
    ) {
      return null;
    }
    paymentAmount = addMoneyAmount(
      paymentAmount,
      invoicePayment.amount_paid,
      `InvoicePayment ${invoicePayment.id} amount_paid`,
    );
    allocatedByPaymentIntent.set(
      invoicePaymentIntentId,
      addMoneyAmount(
        allocatedByPaymentIntent.get(invoicePaymentIntentId) ?? 0,
        invoicePayment.amount_paid,
        `PaymentIntent ${invoicePaymentIntentId} invoice allocation`,
      ),
    );
  }
  if (
    paymentAmount !== invoice.amount_paid ||
    !allocatedByPaymentIntent.has(stripePaymentIntentId)
  ) {
    return null;
  }

  let reversalAmount = 0;
  for (const [paymentIntentId, allocatedAmount] of allocatedByPaymentIntent) {
    const canonicalRefundState = await getCanonicalPaymentRefundState({
      stripe,
      stripePaymentIntentId: paymentIntentId,
    });
    const paymentIntent = canonicalRefundState.paymentIntent;
    if (
      paymentIntent.id !== paymentIntentId ||
      getExpandableId(paymentIntent.customer) !== customerId ||
      paymentIntent.currency.toLowerCase() !== currency ||
      canonicalRefundState.currency !== currency ||
      paymentIntent.amount_received < allocatedAmount
    ) {
      return null;
    }
    const activeDisputeAmount = await getActivePaymentIntentDisputeAmount({
      stripe,
      paymentIntent,
      customerId,
      currency,
    });
    if (activeDisputeAmount === null) return null;
    const activeRefundAmount =
      canonicalRefundState.succeededAmount +
      canonicalRefundState.pendingAmount;
    assertMoneyAmount(
      activeRefundAmount,
      `PaymentIntent ${paymentIntent.id} active refund amount`,
    );
    reversalAmount = addMoneyAmount(
      reversalAmount,
      Math.min(
        allocatedAmount,
        activeRefundAmount + activeDisputeAmount,
      ),
      `PaymentIntent ${paymentIntent.id} active reversal amount`,
    );
  }

  return { paymentAmount, reversalAmount, currency };
}


export type OwnedSubscriptionInvoicePayment = {
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  customerId: string;
  customer: NonNullable<Awaited<ReturnType<typeof findCustomerByStripeId>>>;
};

// A single paid InvoicePayment for this PaymentIntent, its invoice, the
// subscription it bills, and the Beutl user who provably owns that
// subscription. Null whenever any link is missing or ambiguous; the caller
// then leaves the payment to the package-store path.
export async function resolveOwnedSubscriptionInvoicePayment(
  stripe: StripeClient,
  stripePaymentIntentId: string,
): Promise<OwnedSubscriptionInvoicePayment | null> {
  const invoicePayments = await listAllInvoicePayments(stripe, {
    payment: {
      type: "payment_intent",
      payment_intent: stripePaymentIntentId,
    },
    status: "paid",
  });
  if (invoicePayments.length !== 1) {
    return null;
  }
  const invoicePayment = invoicePayments[0];
  const invoiceId = getExpandableId(invoicePayment.invoice);
  if (
    !invoiceId ||
    invoicePayment.status !== "paid" ||
    invoicePayment.payment.type !== "payment_intent" ||
    getExpandableId(invoicePayment.payment.payment_intent) !==
      stripePaymentIntentId ||
    invoicePayment.amount_paid === null ||
    invoicePayment.amount_paid <= 0
  ) {
    return null;
  }
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const invoiceSubscription = getInvoiceSubscription(invoice);
  const subscriptionId = getExpandableId(invoiceSubscription);
  if (!subscriptionId) return null;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = getExpandableId(subscription.customer);
  if (!customerId || getExpandableId(invoice.customer) !== customerId) {
    return null;
  }
  const customer = await findCustomerByStripeId({ stripeId: customerId });
  if (
    !customer ||
    !isOwnedSubscription(
      subscription,
      customerId,
      customer.userId,
      customer.ownership,
    )
  ) {
    return null;
  }
  return { invoice, subscription, customerId, customer };
}
