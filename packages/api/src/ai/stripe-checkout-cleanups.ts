import Stripe from "stripe";
import {
  allowsStripePromotionCodes,
  isValidStripeCheckoutAmount,
  isValidStripeCheckoutSessionAmount,
  isZeroCostStripeCheckoutSessionAmount,
} from "@beutl/core";
import { discoverPackageCheckoutAttempt, discoverTopUpCheckoutAttempt, discoverLegacyPackageCheckoutAttempt } from "../package-checkout-discovery";
import {
  completeStripeCheckoutCleanup,
  claimStripeCheckoutCleanup,
  listDueStripeCheckoutCleanups,
  markStripeCheckoutCleanupIntervention,
  rescheduleStripeCheckoutCleanup,
  scheduleBillingRefundAttempt,
  recordBillingRefundCancellation,
  schedulePackagePaymentRefundAttempt,
  claimDetachedPackageCheckoutAttempt,
  claimPackageCheckoutInterventions,
  bindDetachedPackageCheckoutRecoveryAndScheduleCleanup,
  markDetachedPackageCheckoutRecoveryTerminal,
  rescheduleDetachedPackageCheckoutRecovery,
  markDetachedPackageCheckoutRecoveryIntervention,
  scheduleStripeCheckoutCleanup,
  claimUnboundTopUpCheckoutRecoveries,
  setTopUpCheckoutSession,
  clearDetachedTopUpCheckoutRecovery,
  markDetachedTopUpCheckoutRecoveryIntervention,
  markDetachedTopUpCheckoutRecoveryTerminal,
  scheduleTopUpDuplicateRefundAttempt,
  topUpCheckoutResolutionRefundState,
  markTopUpResolutionAndAttemptIntervention,
  finalizeTopUpCheckoutResolutionAtomically,
  getTopUpCheckoutResolution,
  scheduleTopUpCheckoutResolution,
  claimDetachedProCheckoutAttempts,
  completeDetachedProCheckoutRecovery,
  markDetachedProCheckoutRecoveryTerminal,
  rescheduleDetachedProCheckoutRecovery,
  markDetachedProCheckoutRecoveryIntervention,
  completeDetachedTopUpCheckoutRecovery,
  findBillingOfferById,
  deleteProCheckoutAttemptBySessionId,
  deletePackageCheckoutAttemptBySessionId,
  resolvePackageCheckoutAttemptIntervention,
  markPackageCheckoutAttemptIntervention,
  bindPackageCheckoutIntervention,
  terminalizePackageCheckoutIntervention,
  reschedulePackageCheckoutIntervention,
  schedulePackageCheckoutResolutionRefunds,
  recordPackageCheckoutIntervention,
  packageCheckoutResolutionRefundState,
  markPackageCheckoutResolutionIntervention,
  finalizePackageCheckoutResolution,
  findPackagePaymentReference,
  getPackageCheckoutResolution,
} from "@beutl/db";

const LEASE_MS = 10 * 60_000;
export const PACKAGE_CHECKOUT_CREATE_TIMEOUT_MS = 60_000;
const STRIPE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;

export type LegacyPackageResolutionChoice =
  | { kind: "choose"; sessionId: string }
  | { kind: "all-refund" };

/**
 * Admin-safe legacy resolver entrypoint. The caller must supply the current
 * attempt token and an explicit choice; Stripe is rehydrated before any bind or
 * refund scheduling, so an operator cannot inject amount or PaymentIntent data.
 */
export async function resolveLegacyPackageCheckoutMultiple({
  stripe,
  attempt,
  discoveryToken,
  recoveryLeaseToken,
  operatorUserId,
  choice,
  now = new Date(),
}: {
  stripe: Pick<Stripe, "checkout" | "paymentIntents" | "refunds">;
  attempt: { id: string; checkoutKey: string; discoveryToken: string; userId: string; packageId: string; customerId: string; paramsJson: string; accountDeletionAt?: Date | null };
  discoveryToken: string;
  recoveryLeaseToken?: string;
  operatorUserId: string;
  choice: LegacyPackageResolutionChoice;
  now?: Date;
}) {
  if (discoveryToken !== attempt.discoveryToken) throw new Error("Legacy resolver token is stale");
  const discovery = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson), customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
  if (discovery.status !== "multiple") throw new Error("Legacy resolver requires multiple discovered Sessions");
  const selected = choice.kind === "choose" ? discovery.sessions.find((session) => session.id === choice.sessionId) : null;
  if (choice.kind === "choose" && (!selected || selected.status !== "complete")) throw new Error("Chosen legacy Session is not complete");
  const hydrated = await hydrateCompletedPackagePayments(stripe, discovery.sessions.filter((session) => session.status === "complete"), attempt);
  const refunds = (choice.kind === "all-refund" ? hydrated : hydrated.filter((payment) => payment.session.id !== selected!.id)).filter((payment) => payment.unrefunded).map((payment) => ({ paymentIntentId: payment.paymentIntentId, amount: payment.amount, currency: payment.currency, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId }));
  if (!recoveryLeaseToken) throw new Error("Legacy resolver requires a recovery lease");
  await schedulePackageCheckoutResolutionRefunds({ attemptId: attempt.id, discoveryToken, recoveryLeaseToken, operatorUserId, canonicalSessionId: selected?.id ?? null, canonicalPaymentIntentId: selected ? hydrated.find((payment) => payment.session.id === selected.id)?.paymentIntentId ?? null : null, refunds, evidenceJson: JSON.stringify({ legacy: true, choice, sessions: discovery.sessions.map((session) => ({ id: session.id, status: session.status })) }), now });
  return { canonicalSessionId: selected?.id ?? null, refundCount: refunds.length };
}

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.min(attempts, 6), 6 * 60 * 60_000);
}

type HydratedPackagePayment = {
  session: Stripe.Checkout.Session;
  paymentIntentId: string;
  amount: number;
  currency: string;
  chargeCreated: number;
  activeFulfilled: boolean;
  unrefunded: boolean;
};

type HydratedTopUpPayment = {
  session: Stripe.Checkout.Session;
  paymentIntentId: string;
  amount: number;
  currency: string;
  chargeCreated: number;
  refunded: number;
};

async function hydrateTopUpPayments(
  stripe: Pick<Stripe, "paymentIntents" | "refunds">,
  sessions: Stripe.Checkout.Session[],
  attempt: {
    id: string;
    ownerUserId: string;
    stripeCustomerId: string;
    billingOfferId: string;
    paramsJson?: string | null;
  },
): Promise<HydratedTopUpPayment[]> {
  const offer = await findBillingOfferById({ id: attempt.billingOfferId });
  if (
    !offer ||
    offer.kind !== "top_up" ||
    !Number.isSafeInteger(offer.unitAmount) ||
    offer.unitAmount <= 0 ||
    !Number.isSafeInteger(offer.creditAmount) ||
    (offer.creditAmount ?? 0) <= 0
  ) {
    throw new Error("Top-up recovery billing offer is invalid");
  }
  const promotionCodesEnabled = allowsStripePromotionCodes(attempt.paramsJson);
  const hydrated: HydratedTopUpPayment[] = [];
  for (const session of sessions) {
    const sessionCustomer = typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
    if (!paymentIntentId) {
      if (
        session.status === "complete" &&
        session.mode === "payment" &&
        sessionCustomer === attempt.stripeCustomerId &&
        session.metadata?.beutlApplication === "beutl-web" &&
        session.metadata?.beutlUserId === attempt.ownerUserId &&
        session.metadata?.topUpAttemptId === attempt.id &&
        session.metadata?.billingOfferId === attempt.billingOfferId &&
        session.metadata?.creditAmount === String(offer.creditAmount) &&
        (session.currency === null ||
          session.currency.toLowerCase() === offer.currency.toLowerCase()) &&
        isZeroCostStripeCheckoutSessionAmount(
          {
            amountSubtotal: session.amount_subtotal,
            amountTotal: session.amount_total,
          },
          offer.unitAmount,
          promotionCodesEnabled,
        )
      ) {
        continue;
      }
      throw new Error(`Completed top-up Session ${session.id} has no PaymentIntent`);
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] },
    );
    const customer = typeof paymentIntent.customer === "string"
      ? paymentIntent.customer
      : paymentIntent.customer?.id;
    if (
      paymentIntent.status !== "succeeded" ||
      paymentIntent.amount_received !== paymentIntent.amount ||
      customer !== attempt.stripeCustomerId ||
      paymentIntent.metadata?.topUpAttemptId !== attempt.id ||
      paymentIntent.metadata?.beutlUserId !== attempt.ownerUserId ||
      paymentIntent.metadata?.billingOfferId !== attempt.billingOfferId ||
      paymentIntent.metadata?.creditAmount !== String(offer.creditAmount) ||
      !isValidStripeCheckoutAmount(
        paymentIntent.amount,
        offer.unitAmount,
        promotionCodesEnabled,
      ) ||
      paymentIntent.currency.toLowerCase() !== offer.currency.toLowerCase() ||
      !isValidStripeCheckoutSessionAmount(
        {
          amountSubtotal: session.amount_subtotal,
          amountTotal: session.amount_total,
        },
        offer.unitAmount,
        promotionCodesEnabled,
        !promotionCodesEnabled,
      ) ||
      (session.amount_total !== null &&
        session.amount_total !== undefined &&
        session.amount_total !== paymentIntent.amount) ||
      (session.currency !== null &&
        session.currency.toLowerCase() !== offer.currency.toLowerCase()) ||
      !paymentIntent.latest_charge ||
      typeof paymentIntent.latest_charge === "string"
    ) {
      throw new Error(`PaymentIntent ${paymentIntentId} failed top-up validation`);
    }
    const refunds: Stripe.Refund[] = [];
    let refundCursor: string | undefined;
    for (;;) {
      const page = await stripe.refunds.list({
        payment_intent: paymentIntentId,
        limit: 100,
        ...(refundCursor ? { starting_after: refundCursor } : {}),
      });
      refunds.push(...page.data);
      if (!page.has_more) break;
      refundCursor = page.data.at(-1)?.id;
      if (!refundCursor) {
        throw new Error("Stripe returned an empty top-up refund page with has_more");
      }
    }
    if (refunds.some((refund) =>
      refund.status !== "succeeded" &&
      refund.status !== "failed" &&
      refund.status !== "canceled")) {
      throw new Error(`PaymentIntent ${paymentIntentId} has a nonterminal refund`);
    }
    if (refunds.some((refund) =>
      refund.currency.toLowerCase() !== offer.currency.toLowerCase())) {
      throw new Error(`PaymentIntent ${paymentIntentId} has a refund currency mismatch`);
    }
    const refunded = refunds.filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amount, 0);
    if (refunded > paymentIntent.amount) {
      throw new Error(`PaymentIntent ${paymentIntentId} is over-refunded`);
    }
    hydrated.push({
      session,
      paymentIntentId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      chargeCreated: paymentIntent.latest_charge.created,
      refunded,
    });
  }
  return hydrated;
}

async function hydrateCompletedPackagePayments(
  stripe: Pick<Stripe, "paymentIntents" | "refunds">,
  sessions: Stripe.Checkout.Session[],
  attempt: { customerId: string; userId: string; packageId: string; paramsJson: string },
): Promise<HydratedPackagePayment[]> {
  const params = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
  const priceData = params.line_items?.[0] && "price_data" in params.line_items[0] ? params.line_items[0].price_data : undefined;
  const expectedAmount = priceData?.unit_amount;
  const expectedCurrency = priceData?.currency?.toLowerCase();
  const hydrated: HydratedPackagePayment[] = [];
  for (const session of sessions) {
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntentId) throw new Error(`Completed Session ${session.id} has no PaymentIntent`);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    const customerId = typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer?.id;
    if (paymentIntent.status !== "succeeded" || paymentIntent.amount_received !== paymentIntent.amount || customerId !== attempt.customerId || paymentIntent.metadata?.beutlUserId !== attempt.userId || paymentIntent.metadata?.packageId !== attempt.packageId || paymentIntent.metadata?.beutlPurchaseKind !== "package") throw new Error(`PaymentIntent ${paymentIntentId} failed package identity validation`);
    if (expectedAmount !== undefined && paymentIntent.amount !== expectedAmount || expectedCurrency !== undefined && paymentIntent.currency.toLowerCase() !== expectedCurrency || session.amount_total !== null && session.amount_total !== paymentIntent.amount || session.currency && session.currency.toLowerCase() !== paymentIntent.currency.toLowerCase()) throw new Error(`PaymentIntent ${paymentIntentId} failed amount/currency validation`);
    const reference = await findPackagePaymentReference({ paymentId: paymentIntentId });
    const refunds: Stripe.Refund[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      refunds.push(...page.data);
      if (!page.has_more) break;
      cursor = page.data.at(-1)?.id;
      if (!cursor) throw new Error(`Stripe returned an empty refund page for ${paymentIntentId}`);
    }
    const refunded = refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
    const charge = paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== "string" ? paymentIntent.latest_charge : null;
    if (!charge) throw new Error(`PaymentIntent ${paymentIntentId} has no expanded latest Charge`);
    if (refunds.some((refund) => refund.status === "pending")) throw new Error(`PaymentIntent ${paymentIntentId} has a pending refund`);
    hydrated.push({ session, paymentIntentId, amount: paymentIntent.amount, currency: paymentIntent.currency, chargeCreated: charge.created, activeFulfilled: reference?.fulfillmentValidated === true && reference.revokedAt === null, unrefunded: refunded < paymentIntent.amount });
  }
  return hydrated;
}

export async function reconcileStripeCheckoutCleanups(
  now = new Date(),
  secretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient?: Pick<Stripe, "checkout" | "paymentIntents" | "invoicePayments" | "subscriptions" | "refunds">,
) {
  if (!stripeClient && !secretKey) return { inspected: 0, completed: 0, pending: 0, interventionRequired: 0, detachedInspected: 0, detachedRecovered: 0, detachedPending: 0, detachedIntervention: 0 };
  const stripe = stripeClient ?? new Stripe(secretKey!);
  const recoveryLeaseToken = crypto.randomUUID();
  const detached = await claimDetachedPackageCheckoutAttempt({
    now,
    leaseToken: recoveryLeaseToken,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
  });
  const interventions = await claimPackageCheckoutInterventions({ now, leaseToken: recoveryLeaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) });
  for (const attempt of interventions) {
    try {
      const discovery = await discoverPackageCheckoutAttempt({ stripe, expected: { customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId, discoveryToken: attempt.discoveryToken, createdAt: attempt.createdAt } });
      if (!JSON.parse(attempt.paramsJson).metadata?.packageCheckoutAttemptId) {
        const storedResolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
        if (storedResolution && (storedResolution.status === "refund_pending" || storedResolution.status === "intervention" || storedResolution.status === "resolved")) {
          const state = await packageCheckoutResolutionRefundState({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
          if (state === "intervention") {
            await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 60 * 60_000), lastError: "Operator-selected refund requires intervention" });
            continue;
          }
          if (state === "pending") {
            await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Waiting for operator-selected refunds" });
            continue;
          }
          if (state === "settled" || storedResolution.status === "resolved") {
            if (storedResolution.canonicalSessionId) {
              const refreshed = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson), customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
              const chosen = refreshed.status === "multiple" ? refreshed.sessions.find((session) => session.id === storedResolution.canonicalSessionId && session.status === "complete") : refreshed.status === "single" && refreshed.session.id === storedResolution.canonicalSessionId ? refreshed.session : null;
              if (!chosen) throw new Error("Stored legacy canonical Session is no longer valid");
              for (const open of refreshed.status === "multiple" ? refreshed.sessions.filter((session) => session.status === "open") : []) {
                const expired = await stripe.checkout.sessions.expire(open.id).catch(() => stripe.checkout.sessions.retrieve(open.id));
                if (expired.status === "open") throw new Error("Legacy duplicate Checkout Session remains open");
              }
              const finalDiscovery = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson), customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
              const raced = finalDiscovery.status === "multiple" ? finalDiscovery.sessions.filter((session) => session.status === "complete" && session.id !== chosen.id) : [];
              if (raced.length > 0) {
                const hydrated = await hydrateCompletedPackagePayments(stripe, raced, attempt);
                const refunds = hydrated.filter((payment) => payment.unrefunded).map((payment) => ({ paymentIntentId: payment.paymentIntentId, amount: payment.amount, currency: payment.currency, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId }));
                if (refunds.length > 0) {
                  await schedulePackageCheckoutResolutionRefunds({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, recoveryLeaseToken, expectedRevision: storedResolution.revision, canonicalSessionId: storedResolution.canonicalSessionId, canonicalPaymentIntentId: storedResolution.canonicalPaymentIntentId, refunds, evidenceJson: storedResolution.evidenceJson, now });
                  await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Legacy duplicate completed during resolver consumption" });
                  continue;
                }
              }
              await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: storedResolution.revision, finalization: { outcome: "bind", sessionId: chosen.id, expiresAt: chosen.expires_at ? new Date(chosen.expires_at * 1000) : attempt.expiresAt } });
            } else {
              const beforeTerminal = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson), customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
              for (const open of beforeTerminal.status === "multiple" ? beforeTerminal.sessions.filter((session) => session.status === "open") : beforeTerminal.status === "single" && beforeTerminal.session.status === "open" ? [beforeTerminal.session] : []) {
                const expired = await stripe.checkout.sessions.expire(open.id).catch(() => stripe.checkout.sessions.retrieve(open.id));
                if (expired.status === "open") throw new Error("Legacy all-refund Session remains open");
              }
              const finalLegacy = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson), customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
              const raced = finalLegacy.status === "multiple"
                ? finalLegacy.sessions.filter((session) => session.status === "complete")
                : finalLegacy.status === "single" && finalLegacy.session.status === "complete"
                  ? [finalLegacy.session]
                  : [];
              if (raced.length > 0) {
                const hydrated = await hydrateCompletedPackagePayments(stripe, raced, attempt);
                const refunds = hydrated.filter((payment) => payment.unrefunded).map((payment) => ({ paymentIntentId: payment.paymentIntentId, amount: payment.amount, currency: payment.currency, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId }));
                if (refunds.length > 0) {
                  await schedulePackageCheckoutResolutionRefunds({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, recoveryLeaseToken, expectedRevision: storedResolution.revision, canonicalSessionId: null, canonicalPaymentIntentId: null, refunds, evidenceJson: storedResolution.evidenceJson, now });
                  await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Legacy all-refund completion race" });
                  continue;
                }
              }
              await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: storedResolution.revision, finalization: { outcome: "terminal" } });
            }
            continue;
          }
        }
        const legacy = await discoverLegacyPackageCheckoutAttempt({ stripe, params: JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId, createdAt: attempt.createdAt });
        if (legacy.status === "single") {
          if (legacy.session.status === "expired") {
            if ((await terminalizePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, lastError: `Expired legacy Session ${legacy.session.id}` })).count !== 1) throw new Error("Legacy intervention terminalization lease lost");
          } else {
            if ((await bindPackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: legacy.session.id, expiresAt: legacy.session.expires_at ? new Date(legacy.session.expires_at * 1000) : attempt.expiresAt })).count !== 1) throw new Error("Legacy intervention binding lease lost");
          }
        } else if (legacy.status === "none" && now.getTime() - attempt.createdAt.getTime() < STRIPE_IDEMPOTENCY_RETENTION_MS) {
          const oldSession = await stripe.checkout.sessions.create(JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams, { idempotencyKey: attempt.checkoutKey, timeout: PACKAGE_CHECKOUT_CREATE_TIMEOUT_MS, maxNetworkRetries: 2 });
          if (oldSession.status === "expired") {
            if ((await terminalizePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, lastError: `Expired legacy replay ${oldSession.id}` })).count !== 1) throw new Error("Legacy replay terminalization lease lost");
          } else if ((await bindPackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: oldSession.id, expiresAt: oldSession.expires_at ? new Date(oldSession.expires_at * 1000) : attempt.expiresAt })).count !== 1) throw new Error("Legacy replay binding lease lost");
        } else {
          const marker = `absence:${attempt.discoveryToken}:`;
          const previous = typeof attempt.recoveryLastError === "string" && attempt.recoveryLastError.startsWith(marker) ? Date.parse(attempt.recoveryLastError.slice(marker.length)) : NaN;
          if (legacy.status === "none" && Number.isFinite(previous) && now.getTime() - previous >= 5 * 60_000) await terminalizePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, lastError: "Legacy Checkout absence confirmed" });
          else await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: `${marker}${now.toISOString()}` });
        }
        continue;
      }
      if (discovery.status === "single") {
        if (discovery.session.status === "expired") {
          await terminalizePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, lastError: `Expired intervention Session ${discovery.session.id}` });
        } else {
          if (discovery.session.status === "complete" && attempt.accountDeletionAt) await scheduleStripeCheckoutCleanup({ sessionId: discovery.session.id, userId: attempt.userId, kind: "package", customerId: attempt.customerId, packageId: attempt.packageId, now });
          await bindPackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: discovery.session.id, expiresAt: discovery.session.expires_at ? new Date(discovery.session.expires_at * 1000) : attempt.expiresAt });
        }
      } else if (discovery.status === "multiple") {
        let unresolved = false;
        const evidence = JSON.stringify(discovery.sessions.map((session) => ({ id: session.id, status: session.status })).sort((a, b) => a.id.localeCompare(b.id)));
        const priorResolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
        if (!priorResolution) await recordPackageCheckoutIntervention({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, evidenceJson: evidence });
        const finalSessions = new Map(discovery.sessions.map((session) => [session.id, session]));
        for (const open of discovery.sessions.filter((session) => session.status === "open")) {
          try {
            const expired = await stripe.checkout.sessions.expire(open.id);
            finalSessions.set(expired.id, expired);
          } catch {
            const current = await stripe.checkout.sessions.retrieve(open.id, { expand: ["payment_intent"] });
            finalSessions.set(current.id, current);
            if (current.status === "open") unresolved = true;
          }
        }
        if (unresolved) {
          await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Multiple Checkout Sessions still include unresolved open state" });
          continue;
        }
        const completeSessions = [...finalSessions.values()].filter((session) => session.status === "complete");
        if (!attempt.accountDeletionAt && completeSessions.length > 0) {
          const hydrated = await hydrateCompletedPackagePayments(stripe, completeSessions, attempt);
          const active = hydrated.filter((payment) => payment.activeFulfilled && payment.unrefunded);
          const canonical = (active.length === 1 ? active : active.length > 1 ? [...active].sort((a, b) => a.chargeCreated - b.chargeCreated || a.paymentIntentId.localeCompare(b.paymentIntentId)) : hydrated.filter((payment) => payment.unrefunded).sort((a, b) => a.chargeCreated - b.chargeCreated || a.paymentIntentId.localeCompare(b.paymentIntentId))).at(0);
          if (!canonical) {
            const resolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
            if (!resolution) throw new Error("Missing package checkout resolution");
            await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: resolution.revision, finalization: { outcome: "terminal" } });
            continue;
          }
          const canonicalPi = canonical.paymentIntentId;
          const duplicateRefunds = [] as Array<{ paymentIntentId: string; amount: number; currency: string; customerId: string; userId: string; packageId: string }>;
          for (const duplicate of hydrated.filter((payment) => payment.paymentIntentId !== canonicalPi && payment.unrefunded)) {
            duplicateRefunds.push({ paymentIntentId: duplicate.paymentIntentId, amount: duplicate.amount, currency: duplicate.currency, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId });
          }
          if (duplicateRefunds.length > 0) {
            await schedulePackageCheckoutResolutionRefunds({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, recoveryLeaseToken: recoveryLeaseToken, expectedRevision: (await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken }))?.revision, canonicalSessionId: canonical.session.id, canonicalPaymentIntentId: canonicalPi, refunds: duplicateRefunds, evidenceJson: evidence, now });
            const refundState = await packageCheckoutResolutionRefundState({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
            if (refundState === "intervention") {
              await markPackageCheckoutResolutionIntervention({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, lastError: "Duplicate payment refund requires intervention" });
              await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 60 * 60_000), lastError: "Duplicate payment refund requires intervention" });
              continue;
            }
            if (refundState !== "settled") {
              await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Waiting for duplicate payment refunds" });
              continue;
            }
          }
          const resolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
          if (!resolution) throw new Error("Missing package checkout resolution");
          await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: resolution.revision, finalization: { outcome: "bind", sessionId: canonical.session.id, expiresAt: canonical.session.expires_at ? new Date(canonical.session.expires_at * 1000) : attempt.expiresAt } });
          continue;
        }
        if (attempt.accountDeletionAt && completeSessions.length > 0) {
          const hydrated = await hydrateCompletedPackagePayments(stripe, completeSessions, attempt);
          const refunds = hydrated.filter((payment) => payment.unrefunded).map((payment) => ({ paymentIntentId: payment.paymentIntentId, amount: payment.amount, currency: payment.currency, customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId }));
          if (refunds.length > 0) await schedulePackageCheckoutResolutionRefunds({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, recoveryLeaseToken: recoveryLeaseToken, expectedRevision: (await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken }))?.revision, canonicalSessionId: null, canonicalPaymentIntentId: null, refunds, evidenceJson: evidence, now });
          else {
            const resolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
            if (!resolution) throw new Error("Missing package checkout resolution");
            await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: resolution.revision, finalization: { outcome: "terminal" } });
            continue;
          }
        }
        if (!unresolved) {
          const resolutionState = await packageCheckoutResolutionRefundState({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
          if (resolutionState === "none" && completeSessions.length === 0) {
            const resolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
            if (!resolution) throw new Error("Missing package checkout resolution");
            await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: resolution.revision, finalization: { outcome: "terminal" } });
            continue;
          } else if ((await packageCheckoutResolutionRefundState({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken })) === "settled") {
            const resolution = await getPackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken });
            if (!resolution) throw new Error("Missing package checkout resolution");
            await finalizePackageCheckoutResolution({ attemptId: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, revision: resolution.revision, finalization: { outcome: "terminal" } });
          }
          else { await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Waiting for package checkout duplicate refunds" }); continue; }
        }
        else await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: "Multiple intervention Sessions still include unresolved open state" });
      } else {
        const marker = `absence:${attempt.discoveryToken}:`;
        const previous = typeof attempt.recoveryLastError === "string" && attempt.recoveryLastError.startsWith(marker) ? Date.parse(attempt.recoveryLastError.slice(marker.length)) : NaN;
        if (Number.isFinite(previous) && now.getTime() - previous >= 5 * 60_000) await terminalizePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, lastError: `Authoritative absence confirmed at ${now.toISOString()}` });
        else await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: `${marker}${now.toISOString()}` });
      }
    } catch (error) {
      await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken: attempt.discoveryToken, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + 5 * 60_000), lastError: error instanceof Error ? error.message : String(error) });
    }
  }
  let detachedRecovered = 0;
  let detachedPending = 0;
  let detachedIntervention = 0;
  const detachedTopUps = await claimUnboundTopUpCheckoutRecoveries({ now, leaseToken: recoveryLeaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) });
  for (const attempt of detachedTopUps) {
    try {
      const topUpResolution = await getTopUpCheckoutResolution({ topUpAttemptId: attempt.id });
      const refundState = await topUpCheckoutResolutionRefundState({ topUpAttemptId: attempt.id });
      const settled = refundState === "settled";
      if (topUpResolution?.status === "intervention") {
        await markDetachedTopUpCheckoutRecoveryIntervention({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: topUpResolution.lastError ?? "Top-up resolution requires intervention" });
        continue;
      }
      if (refundState === "intervention") {
        await markTopUpResolutionAndAttemptIntervention({ topUpAttemptId: attempt.id, recoveryLeaseToken, lastError: "Top-up duplicate refund requires intervention" });
        continue;
      }
      if (refundState === "pending") {
        await clearDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: "Waiting for top-up duplicate refunds", notBefore: new Date(now.getTime() + 5 * 60_000) });
        continue;
      }
      if (settled && attempt.stripeCheckoutSessionId === null) {
        const resolution = await getTopUpCheckoutResolution({ topUpAttemptId: attempt.id });
        const canonical = resolution?.canonicalSessionId;
        if (!canonical) { await finalizeTopUpCheckoutResolutionAtomically({ topUpAttemptId: attempt.id, recoveryLeaseToken, finalization: { outcome: "terminal" } }); continue; }
        let finalization: Parameters<typeof finalizeTopUpCheckoutResolutionAtomically>[0]["finalization"] = {
          outcome: "bind",
          sessionId: canonical,
          expiresAt: attempt.expiresAt,
        };
        if (attempt.accountDeletionAt === null) {
          const canonicalSession = await stripe.checkout.sessions.retrieve(canonical);
          const [payment] = await hydrateTopUpPayments(
            stripe,
            [canonicalSession],
            attempt,
          );
          if (
            !payment ||
            payment.paymentIntentId !== resolution?.canonicalPaymentIntentId ||
            payment.refunded !== 0
          ) {
            throw new Error("Top-up canonical payment changed before fulfillment");
          }
          finalization = {
            outcome: "fulfill",
            sessionId: canonical,
            expiresAt: canonicalSession.expires_at
              ? new Date(canonicalSession.expires_at * 1_000)
              : attempt.expiresAt,
            paymentIntentId: payment.paymentIntentId,
            stripePayment: {
              amount: payment.amount,
              currency: payment.currency,
            },
          };
        }
        const finalized = await finalizeTopUpCheckoutResolutionAtomically({ topUpAttemptId: attempt.id, recoveryLeaseToken, finalization });
        if (!finalized) throw new Error("Top-up resolution finalization lease lost");
        continue;
      }
      const topUpDiscovery = await discoverTopUpCheckoutAttempt({ stripe, customerId: attempt.stripeCustomerId, userId: attempt.ownerUserId, attemptId: attempt.id, billingOfferId: attempt.billingOfferId, createdAt: attempt.createdAt });
      const inactiveLegacy = attempt.accountDeletionAt === null &&
        attempt.activeOwnerKey === null;
      const expireOpenSessions = attempt.accountDeletionAt !== null ||
        inactiveLegacy;
      const resolveCompleted = async (completed: Stripe.Checkout.Session[]) => {
        if (attempt.accountDeletionAt !== null && completed.length === 1) {
          const [canonical] = completed;
          const stored = await completeDetachedTopUpCheckoutRecovery({
            attemptId: attempt.id,
            leaseToken: recoveryLeaseToken,
            stripeCheckoutSessionId: canonical!.id,
            expiresAt: canonical!.expires_at
              ? new Date(canonical!.expires_at * 1_000)
              : attempt.expiresAt,
          });
          if (stored === "not-stored") {
            throw new Error("Top-up deletion recovery binding lease lost");
          }
          return;
        }
        const hydrated = await hydrateTopUpPayments(stripe, completed, attempt);
        const preferred = attempt.stripePaymentIntentId
          ? hydrated.find((payment) =>
              payment.paymentIntentId === attempt.stripePaymentIntentId &&
              payment.refunded === 0)
          : undefined;
        const canonical = inactiveLegacy
          ? undefined
          : preferred ?? [...hydrated].filter((payment) =>
              payment.refunded === 0).sort((left, right) =>
                left.chargeCreated - right.chargeCreated ||
                left.paymentIntentId.localeCompare(right.paymentIntentId))[0];
        const refunds = hydrated.filter((payment) =>
          payment.paymentIntentId !== canonical?.paymentIntentId &&
          payment.refunded < payment.amount).map((payment) => ({
            paymentIntentId: payment.paymentIntentId,
            amount: payment.amount,
            currency: payment.currency,
          }));
        if (refunds.length === 0) {
          if (canonical) {
            await scheduleTopUpCheckoutResolution({
              topUpAttemptId: attempt.id,
              recoveryLeaseToken,
              ownerUserId: attempt.ownerUserId,
              stripeCustomerId: attempt.stripeCustomerId,
              billingOfferId: attempt.billingOfferId,
              canonicalSessionId: canonical.session.id,
              canonicalPaymentIntentId: canonical.paymentIntentId,
              expectedPaymentIntents: [],
            });
            const finalized = await finalizeTopUpCheckoutResolutionAtomically({
              topUpAttemptId: attempt.id,
              recoveryLeaseToken,
              finalization: {
                outcome: "fulfill",
                sessionId: canonical.session.id,
                expiresAt: canonical.session.expires_at
                  ? new Date(canonical.session.expires_at * 1_000)
                  : attempt.expiresAt,
                paymentIntentId: canonical.paymentIntentId,
                stripePayment: {
                  amount: canonical.amount,
                  currency: canonical.currency,
                },
              },
            });
            if (!finalized) {
              throw new Error("Top-up canonical fulfillment lease lost");
            }
          } else if ((await markDetachedTopUpCheckoutRecoveryTerminal({
            attemptId: attempt.id,
            leaseToken: recoveryLeaseToken,
          })).count !== 1) {
            throw new Error("Top-up terminalization lease lost");
          }
          return;
        }
        await scheduleTopUpCheckoutResolution({
          topUpAttemptId: attempt.id,
          recoveryLeaseToken,
          ownerUserId: attempt.ownerUserId,
          stripeCustomerId: attempt.stripeCustomerId,
          billingOfferId: attempt.billingOfferId,
          canonicalSessionId: canonical?.session.id ?? null,
          canonicalPaymentIntentId: canonical?.paymentIntentId ?? null,
          expectedPaymentIntents: refunds,
        });
        await clearDetachedTopUpCheckoutRecovery({
          attemptId: attempt.id,
          leaseToken: recoveryLeaseToken,
          lastError: "Waiting for top-up duplicate refunds",
          notBefore: new Date(now.getTime() + 5 * 60_000),
        });
      };

      if (topUpDiscovery.status === "multiple") {
        const complete = new Map(
          topUpDiscovery.sessions.filter((item) => item.status === "complete")
            .map((item) => [item.id, item]),
        );
        const open = topUpDiscovery.sessions.filter((item) =>
          item.status === "open").sort((left, right) =>
            (left.created ?? 0) - (right.created ?? 0) ||
            left.id.localeCompare(right.id));
        let preservedOpen = !expireOpenSessions && complete.size === 0
          ? open.shift()
          : undefined;
        let unresolved = false;
        const expireOpen = async (session: Stripe.Checkout.Session) => {
          try {
            const expired = await stripe.checkout.sessions.expire(session.id);
            if (expired.status === "complete") complete.set(expired.id, expired);
            else if (expired.status === "open") unresolved = true;
          } catch {
            const current = await stripe.checkout.sessions.retrieve(session.id);
            if (current.status === "complete") complete.set(current.id, current);
            else if (current.status === "open") unresolved = true;
          }
        };
        for (const duplicate of open) await expireOpen(duplicate);
        if (preservedOpen && complete.size > 0) {
          await expireOpen(preservedOpen);
          preservedOpen = undefined;
        }
        if (unresolved) {
          throw new Error(
            `Multiple top-up Sessions remain open: ${topUpDiscovery.sessions
              .map((item) => `${item.id}:${item.status}`).sort().join(",")}`,
          );
        }
        if (complete.size > 0) {
          await resolveCompleted([...complete.values()]);
        } else if (preservedOpen) {
          const stored = await completeDetachedTopUpCheckoutRecovery({
            attemptId: attempt.id,
            leaseToken: recoveryLeaseToken,
            stripeCheckoutSessionId: preservedOpen.id,
            expiresAt: preservedOpen.expires_at
              ? new Date(preservedOpen.expires_at * 1_000)
              : attempt.expiresAt,
          });
          if (stored === "not-stored") {
            throw new Error("Top-up open canonical binding lease lost");
          }
        } else if ((await markDetachedTopUpCheckoutRecoveryTerminal({
          attemptId: attempt.id,
          leaseToken: recoveryLeaseToken,
        })).count !== 1) {
          throw new Error("Top-up multiple-session terminalization lease lost");
        }
        continue;
      }
      if (topUpDiscovery.status === "single") {
        let discovered = topUpDiscovery.session;
        if (discovered.status === "open" && expireOpenSessions) {
          try {
            discovered = await stripe.checkout.sessions.expire(discovered.id);
          } catch {
            discovered = await stripe.checkout.sessions.retrieve(discovered.id);
          }
        }
        if (discovered.status === "expired") {
          await markDetachedTopUpCheckoutRecoveryTerminal({ attemptId: attempt.id, leaseToken: recoveryLeaseToken });
        } else if (
          discovered.status === "complete" &&
          attempt.accountDeletionAt === null
        ) {
          await resolveCompleted([discovered]);
        } else if (discovered.status === "open" || discovered.status === "complete") {
          const stored = await completeDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: discovered.id, expiresAt: discovered.expires_at ? new Date(discovered.expires_at * 1000) : attempt.expiresAt });
          if (stored === "not-stored") throw new Error("Top-up discovery lease lost");
        } else {
          throw new Error(`Top-up Session remains ${discovered.status ?? "unknown"}`);
        }
        continue;
      }
      if (now.getTime() - attempt.createdAt.getTime() >= STRIPE_IDEMPOTENCY_RETENTION_MS) {
        const marker = `absence:${attempt.id}:`;
        const previous = typeof attempt.recoveryLastError === "string" && attempt.recoveryLastError.startsWith(marker) ? Date.parse(attempt.recoveryLastError.slice(marker.length)) : NaN;
        if (Number.isFinite(previous) && now.getTime() - previous >= 5 * 60_000) await markDetachedTopUpCheckoutRecoveryTerminal({ attemptId: attempt.id, leaseToken: recoveryLeaseToken });
        else await clearDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: `${marker}${now.toISOString()}`, notBefore: new Date(now.getTime() + 5 * 60_000) });
        continue;
      }
      if (!attempt.paramsJson) { await clearDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: `absence:${attempt.id}:${now.toISOString()}`, notBefore: new Date(now.getTime() + 5 * 60_000) }); continue; }
      if (attempt.accountDeletionAt === null && attempt.activeOwnerKey === null) {
        await clearDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: "Legacy inactive top-up attempt awaits Stripe retention expiry", notBefore: new Date(now.getTime() + 5 * 60_000) });
        continue;
      }
      const session = await stripe.checkout.sessions.create(JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams, { idempotencyKey: attempt.checkoutKey });
      if (session.status === "expired") {
        await markDetachedTopUpCheckoutRecoveryTerminal({ attemptId: attempt.id, leaseToken: recoveryLeaseToken });
        continue;
      }
      if (session.mode !== "payment" || (typeof session.customer === "string" ? session.customer : session.customer?.id) !== attempt.stripeCustomerId || session.metadata?.beutlApplication !== "beutl-web" || session.metadata?.beutlUserId !== attempt.ownerUserId || session.metadata?.topUpAttemptId !== attempt.id || session.metadata?.billingOfferId !== attempt.billingOfferId) throw new Error("Detached top-up replay failed canonical validation");
      const stored = await completeDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : attempt.expiresAt });
      if (stored === "not-stored") throw new Error("Top-up replay binding lease lost");
    } catch (error) {
      if (attempt.recoveryAttempts >= 12) await markDetachedTopUpCheckoutRecoveryIntervention({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: error instanceof Error ? error.message : String(error) });
      else await clearDetachedTopUpCheckoutRecovery({ attemptId: attempt.id, leaseToken: recoveryLeaseToken, lastError: error instanceof Error ? error.message : String(error), notBefore: new Date(now.getTime() + 5 * 60_000) });
    }
  }
  const detachedPro = await claimDetachedProCheckoutAttempts({ now, leaseToken: recoveryLeaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) });
  for (const attempt of detachedPro) {
    try {
      if (!attempt.paramsJson || !attempt.customerId) {
        await markDetachedProCheckoutRecoveryIntervention({ userId: attempt.userId, leaseToken: recoveryLeaseToken, lastError: "Detached Pro attempt lacks params or Customer identity; metadata-only operator recovery required" });
        continue;
      }
      const params = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
      let session = await stripe.checkout.sessions.create(params, { idempotencyKey: `ai-pro-checkout:${attempt.checkoutKey}` });
      if (!session.line_items) session = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items.data.price"] });
      const sessionCustomer = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const line = session.line_items?.data?.[0];
      const offer = await findBillingOfferById({ id: attempt.billingOfferId });
      if (session.mode !== "subscription" || sessionCustomer !== attempt.customerId || session.metadata?.beutlUserId !== attempt.userId || session.metadata?.billingOfferId !== attempt.billingOfferId || session.metadata?.planId !== "pro" || !offer || (typeof line?.price === "string" ? line.price : line?.price?.id) !== offer.stripePriceId) throw new Error("Detached Pro replay failed canonical validation");
      if (session.status === "expired") {
        await markDetachedProCheckoutRecoveryTerminal({ userId: attempt.userId, leaseToken: recoveryLeaseToken });
        continue;
      }
      if (!(await completeDetachedProCheckoutRecovery({ userId: attempt.userId, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: session.id, now }))) throw new Error("Detached Pro recovery lease lost");
    } catch (error) {
      if (attempt.recoveryAttempts >= 12) await markDetachedProCheckoutRecoveryIntervention({ userId: attempt.userId, leaseToken: recoveryLeaseToken, lastError: error instanceof Error ? error.message : String(error) });
      else await rescheduleDetachedProCheckoutRecovery({ userId: attempt.userId, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + retryDelay(attempt.recoveryAttempts)), lastError: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const attempt of detached) {
    try {
      if (!attempt.customerId || !attempt.paramsJson) throw new Error("Detached package recovery lacks durable identity or params");
      const params = JSON.parse(attempt.paramsJson!) as Stripe.Checkout.SessionCreateParams;
      const discovery = await discoverPackageCheckoutAttempt({
        stripe,
        expected: { customerId: attempt.customerId, userId: attempt.userId, packageId: attempt.packageId, discoveryToken: attempt.discoveryToken, createdAt: attempt.createdAt },
      });
      if (discovery.status === "multiple") throw new Error("Multiple Checkout Sessions match detached package attempt");
      if (discovery.status === "single") {
        const discovered = discovery.session;
        if (discovered.status === "complete") {
          await scheduleStripeCheckoutCleanup({ sessionId: discovered.id, userId: attempt.userId, kind: "package", customerId: attempt.customerId, packageId: attempt.packageId, now });
          if (!(await bindDetachedPackageCheckoutRecoveryAndScheduleCleanup({ id: attempt.id, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: discovered.id, now }))) throw new Error("Detached package completion discovery lease lost");
          detachedRecovered++;
          continue;
        }
        if (discovered.status === "expired") {
          await markDetachedPackageCheckoutRecoveryTerminal({ id: attempt.id, leaseToken: recoveryLeaseToken });
          detachedRecovered++;
          continue;
        }
        if (!(await bindDetachedPackageCheckoutRecoveryAndScheduleCleanup({ id: attempt.id, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: discovered.id, now }))) throw new Error("Detached package discovery lease lost");
        detachedRecovered++;
        continue;
      }
      if (now.getTime() - attempt.createdAt.getTime() >= STRIPE_IDEMPOTENCY_RETENTION_MS) {
        await markDetachedPackageCheckoutRecoveryIntervention({ id: attempt.id, leaseToken: recoveryLeaseToken, lastError: "Stripe idempotency retention elapsed after exhaustive remote discovery" });
        detachedIntervention++;
        continue;
      }
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey: attempt.checkoutKey, timeout: PACKAGE_CHECKOUT_CREATE_TIMEOUT_MS, maxNetworkRetries: 2 });
      const replayCustomer = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const lineItem = params.line_items?.[0];
      const priceData = lineItem && "price_data" in lineItem ? lineItem.price_data : undefined;
      if (session.mode !== "payment" || replayCustomer !== attempt.customerId || session.metadata?.beutlPurchaseKind !== "package" || session.metadata.beutlUserId !== attempt.userId || session.metadata.packageId !== attempt.packageId || (priceData?.unit_amount !== undefined && session.amount_total !== priceData.unit_amount) || (priceData?.currency && session.currency?.toLowerCase() !== priceData.currency.toLowerCase())) throw new Error("Detached package replay failed canonical Session validation");
      if (session.status === "expired") {
        await markDetachedPackageCheckoutRecoveryTerminal({ id: attempt.id, leaseToken: recoveryLeaseToken });
        detachedRecovered++;
        continue;
      }
      if (!(await bindDetachedPackageCheckoutRecoveryAndScheduleCleanup({ id: attempt.id, leaseToken: recoveryLeaseToken, stripeCheckoutSessionId: session.id, now }))) throw new Error("Detached package recovery lease lost");
      detachedRecovered++;
    } catch (error) {
      if (attempt.recoveryAttempts >= 12) {
        await markDetachedPackageCheckoutRecoveryIntervention({ id: attempt.id, leaseToken: recoveryLeaseToken, lastError: error instanceof Error ? error.message : String(error) });
        detachedIntervention++;
      } else {
        await rescheduleDetachedPackageCheckoutRecovery({ id: attempt.id, leaseToken: recoveryLeaseToken, notBefore: new Date(now.getTime() + Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(attempt.recoveryAttempts, 6))), lastError: error instanceof Error ? error.message : String(error) });
        detachedPending++;
      }
    }
  }
  const rows = await listDueStripeCheckoutCleanups({ now });
  let completed = 0;
  let pending = 0;
  let interventionRequired = 0;
  for (const row of rows) {
    const leaseToken = crypto.randomUUID();
    const claimed = await claimStripeCheckoutCleanup({
      id: row.id,
      now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    });
    if (!claimed) continue;
    try {
      const session = await stripe.checkout.sessions.retrieve(claimed.sessionId, {
        expand: ["payment_intent", "subscription", "invoice", "line_items.data.price"],
      });
      const sessionCustomer = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (
        sessionCustomer !== claimed.customerId ||
        session.metadata?.beutlApplication !== "beutl-web" ||
        session.metadata.beutlUserId !== claimed.userId
      ) throw new Error("Checkout cleanup Session ownership mismatch");
      if (session.status === "open") {
        try {
          const expired = await stripe.checkout.sessions.expire(session.id);
          if (expired.status === "open") throw new Error("Checkout Session remained open after expire");
        } catch (error) {
          const current = await stripe.checkout.sessions.retrieve(session.id);
          if (current.status === "complete") {
            throw new Error("Checkout Session completed during cleanup; retry compensation");
          }
          if (current.status !== "expired") throw error;
        }
      } else if (session.status === "complete") {
        if (claimed.kind === "package") {
          const paymentIntentId = typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;
          if (!paymentIntentId) throw new Error("Package cleanup Session has no PaymentIntent");
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          if (
            paymentIntent.metadata.beutlPurchaseKind !== "package" ||
            paymentIntent.metadata.beutlUserId !== claimed.userId ||
            paymentIntent.metadata.packageId !== claimed.packageId ||
            (typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer?.id) !== claimed.customerId
          ) throw new Error("Package cleanup ownership mismatch");
          await schedulePackagePaymentRefundAttempt({
            paymentIntentId,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            reason: "account deletion Checkout cleanup",
            userId: claimed.userId,
            packageId: claimed.packageId,
            customerId: claimed.customerId,
          });
        } else {
          if (session.metadata?.beutlPurchaseKind !== undefined && session.metadata.beutlPurchaseKind !== "package") {
            if (session.metadata.beutlPurchaseKind !== "pro") throw new Error("Pro cleanup purchase kind mismatch");
          }
          if (session.metadata?.billingOfferId !== claimed.billingOfferId) throw new Error("Pro cleanup offer mismatch");
          const lineItems = session.line_items?.data;
          if (!lineItems || lineItems.length !== 1 || lineItems[0].quantity !== 1) throw new Error("Pro cleanup line item mismatch");
          const offer = claimed.billingOfferId ? await findBillingOfferById({ id: claimed.billingOfferId }) : null;
          if (!offer || offer.kind !== "pro" || (typeof lineItems[0].price === "string" ? lineItems[0].price : lineItems[0].price?.id) !== offer.stripePriceId) throw new Error("Pro cleanup price mismatch");
          const subscriptionId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
          if (!subscriptionId) throw new Error("Pro cleanup Session has no subscription");
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          if ((typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id) !== claimed.customerId) throw new Error("Pro cleanup customer mismatch");
          if (subscription.metadata?.billingOfferId !== claimed.billingOfferId) throw new Error("Pro cleanup offer mismatch");
          if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
            await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false }, { idempotencyKey: `beutl:checkout-cleanup:cancel:${subscription.id}` });
          }
          const invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id;
          if (invoiceId) {
            let invoiceCursor: string | undefined;
            for (;;) {
              const invoicePayments = await stripe.invoicePayments.list({ invoice: invoiceId, status: "paid", limit: 100, ...(invoiceCursor ? { starting_after: invoiceCursor } : {}) });
              for (const invoicePayment of invoicePayments.data) {
              const paymentIntentId = typeof invoicePayment.payment.payment_intent === "string"
                ? invoicePayment.payment.payment_intent
                : invoicePayment.payment.payment_intent?.id;
              if (!paymentIntentId) continue;
              const refundAttempt = await scheduleBillingRefundAttempt({
                disposition: "account-delete-checkout-cleanup",
                sourceKey: `${session.id}:${paymentIntentId}`,
                stripeCustomerId: claimed.customerId,
                stripeCheckoutSessionId: session.id,
                stripeSubscriptionId: subscription.id,
                stripeInvoiceId: invoiceId,
                stripePaymentIntentId: paymentIntentId,
              });
              if (!refundAttempt) throw new Error("Could not persist Pro cleanup refund attempt");
              await recordBillingRefundCancellation({ attemptId: refundAttempt.id, now });
            }
              if (!invoicePayments.has_more) break;
              invoiceCursor = invoicePayments.data.at(-1)?.id;
              if (!invoiceCursor) throw new Error("Stripe returned an empty invoice-payment page with has_more");
            }
          }
        }
      }
      await completeStripeCheckoutCleanup({ id: claimed.id, leaseToken });
      if (claimed.kind === "package") {
        await deletePackageCheckoutAttemptBySessionId({ stripeCheckoutSessionId: claimed.sessionId });
      } else {
        await deleteProCheckoutAttemptBySessionId({ stripeCheckoutSessionId: claimed.sessionId });
      }
      completed++;
    } catch (error) {
      if (claimed.attempts >= 12) {
        await markStripeCheckoutCleanupIntervention({ id: claimed.id, leaseToken, lastError: error instanceof Error ? error.message : String(error) });
        interventionRequired++;
      } else {
        await rescheduleStripeCheckoutCleanup({
          id: claimed.id,
          leaseToken,
          notBefore: new Date(now.getTime() + retryDelay(claimed.attempts)),
          lastError: error instanceof Error ? error.message : String(error),
        });
        pending++;
      }
    }
  }
  return { inspected: rows.length, completed, pending, interventionRequired, detachedInspected: detached.length, detachedRecovered, detachedPending, detachedIntervention };
}
