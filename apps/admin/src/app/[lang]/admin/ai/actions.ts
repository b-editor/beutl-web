"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  deleteAiOperationModel,
  deleteAiSetting,
  listAiOperationModels,
  startRetryableTransaction,
  upsertAiOperationModel,
  upsertAiSetting,
  resumeStorageMultipartIntervention,
  terminalizeStorageMultipartIntervention,
  terminalizeTopUpCheckoutResolutionOnly,
  claimTopUpCheckoutResolutionOperatorLease,
  recordTopUpCheckoutResolutionAbsenceObservation,
  renewTopUpCheckoutResolutionOperatorLease,
  releaseTopUpCheckoutResolutionOperatorLease,
  TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS,
} from "@beutl/db";
import {
  aiCostEstimateKey,
  loadAiCostEstimates,
  loadAiModelCatalog,
  loadAiSettings,
  discoverTopUpCheckoutAttempt,
} from "@beutl/api";
import { getDb } from "@beutl/db";
import { deriveTopUpUnitValue, isAiModelId } from "@beutl/core";
import { resolveOfferPricing } from "@/lib/stripe-pricing";
import { validateAiConfigurationChanges } from "@/lib/ai-configuration-changes";
import {
  AI_DEFAULT_OPERATION_MODELS,
  aiMinimumChargeOf,
} from "@beutl/core";
import { revalidatePath } from "next/cache";
import Stripe from "stripe";

async function verifyCanonicalPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
  expected: {
    topUpAttemptId: string;
    ownerUserId: string;
    stripeCustomerId: string;
    billingOfferId: string;
  },
  sessionId?: string,
): Promise<import("@beutl/db").PaymentIntentResolutionProof> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const paymentCustomer = typeof paymentIntent.customer === "string"
    ? paymentIntent.customer
    : paymentIntent.customer?.id;
  if (
    paymentCustomer !== expected.stripeCustomerId ||
    paymentIntent.metadata?.topUpAttemptId !== expected.topUpAttemptId ||
    paymentIntent.metadata?.beutlUserId !== expected.ownerUserId ||
    paymentIntent.metadata?.billingOfferId !== expected.billingOfferId
  ) {
    throw new Error("Canonical PaymentIntent identity mismatch");
  }
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.refunds.list({
      payment_intent: paymentIntent.id,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    refunds.push(...page.data);
    if (!page.has_more) break;
    const last = page.data.at(-1);
    if (!last) throw new Error("Stripe returned an empty refund page with has_more");
    startingAfter = last.id;
  }
  if (paymentIntent.status === "canceled" && paymentIntent.amount_received === 0) {
    return {
      kind: "payment-intent-unpaid",
      paymentIntentId: paymentIntent.id,
      ...(sessionId ? { sessionId } : {}),
      status: "canceled",
      amountReceived: 0,
      currency: paymentIntent.currency,
    };
  }
  const succeeded = refunds.filter((refund) => refund.status === "succeeded");
  const refundedAmount = succeeded.reduce((sum, refund) => sum + refund.amount, 0);
  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.amount_received <= 0 ||
    refundedAmount < paymentIntent.amount_received
  ) {
    throw new Error("Canonical PaymentIntent is neither canceled-unpaid nor fully refunded");
  }
  return {
    kind: "payment-intent-refunded",
    paymentIntentId: paymentIntent.id,
    ...(sessionId ? { sessionId } : {}),
    status: "succeeded",
    amountReceived: paymentIntent.amount_received,
    refundedAmount,
    refundIds: succeeded.map((refund) => refund.id),
    currency: paymentIntent.currency,
  };
}

function parseStorageInterventionInput(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.objectKey !== "string" || typeof value.uploadId !== "string" || typeof value.expectedRevision !== "number" || typeof value.expectedInterventionAt !== "string") return null;
  const expectedInterventionAt = new Date(value.expectedInterventionAt);
  return Number.isSafeInteger(value.expectedRevision) && Number.isFinite(expectedInterventionAt.getTime()) ? { objectKey: value.objectKey, uploadId: value.uploadId, expectedRevision: value.expectedRevision, expectedInterventionAt } : null;
}

export async function resumeStorageMultipartCleanup(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseStorageInterventionInput(input);
    if (!parsed) return { success: false, message: "Invalid resolver input" };
    const result = await startRetryableTransaction(async (tx) => {
      const transition = await resumeStorageMultipartIntervention({ ...parsed, now: new Date(), prisma: tx });
      if (transition.status === "conflict") return transition;
      await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.storageMultipartInterventionResumed, details: `objectKey: ${parsed.objectKey}, uploadId: ${parsed.uploadId}, revision: ${parsed.expectedRevision}->${transition.revision}`, prisma: tx });
      return transition;
    });
    return result.status === "resumed" ? { success: true, message: "Multipart cleanup resumed" } : { success: false, message: "Resolution changed; reload and retry" };
  });
}

export async function terminalizeStorageMultipartCleanup(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseStorageInterventionInput(input);
    const value = input as Record<string, unknown>;
    if (!parsed || typeof value.operatorReason !== "string" || value.operatorReason.trim().length < 10 || typeof value.operatorEvidence !== "string" || value.operatorEvidence.trim().length < 10) {
      return { success: false, message: "Operator reason and evidence (10+ characters each) are required" };
    }
    const result = await startRetryableTransaction(async (tx) => {
      const transition = await terminalizeStorageMultipartIntervention({ ...parsed, now: new Date(), operatorUserId: session.user.id, operatorReason: value.operatorReason as string, operatorEvidence: value.operatorEvidence as string, prisma: tx });
      if (transition.status === "conflict") return transition;
      await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.storageMultipartInterventionTerminalized, details: `objectKey: ${parsed.objectKey}, uploadId: ${parsed.uploadId}, revision: ${parsed.expectedRevision}, reason: ${value.operatorReason}, evidence: ${value.operatorEvidence}`, prisma: tx });
      return transition;
    });
    return result.status === "terminalized" ? { success: true, message: "Multipart cleanup terminalized" } : { success: false, message: "Resolution changed; reload and retry" };
  });
}

export async function terminalizeOrphanTopUpResolution(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    if (!input || typeof input !== "object") return { success: false, message: "Invalid resolver input" };
    const value = input as Record<string, unknown>;
    if (typeof value.topUpAttemptId !== "string" || typeof value.ownerUserId !== "string" || typeof value.stripeCustomerId !== "string" || typeof value.billingOfferId !== "string" || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || typeof value.operatorReason !== "string" || value.operatorReason.trim().length < 10 || typeof value.operatorEvidence !== "string" || value.operatorEvidence.trim().length < 10) return { success: false, message: "Resolution identity and detailed evidence are required" };
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return { success: false, message: "Stripe is not configured" };
    const leaseToken = crypto.randomUUID();
    let current: Awaited<ReturnType<typeof claimTopUpCheckoutResolutionOperatorLease>> = null;
    let releaseLease = true;
    try {
      const stripe = new Stripe(secret);
      const now = new Date();
      current = await startRetryableTransaction(async (tx) =>
        await claimTopUpCheckoutResolutionOperatorLease({
          topUpAttemptId: value.topUpAttemptId as string,
          expectedRevision: value.expectedRevision as number,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + 10 * 60_000),
          now,
          prisma: tx,
        }));
      if (!current) return { success: false, message: "Resolution changed; reload and retry" };

      let proof: import("@beutl/db").CanonicalResolutionProof;
      if (current.canonicalPaymentIntentId) {
        proof = await verifyCanonicalPaymentIntent(
          stripe,
          current.canonicalPaymentIntentId,
          current,
        );
      } else if (current.canonicalSessionId) {
        const canonicalSession = await stripe.checkout.sessions.retrieve(
          current.canonicalSessionId,
          { expand: ["payment_intent"] },
        );
        const sessionCustomer = typeof canonicalSession.customer === "string"
          ? canonicalSession.customer
          : canonicalSession.customer?.id;
        if (sessionCustomer !== current.stripeCustomerId || canonicalSession.metadata?.topUpAttemptId !== current.topUpAttemptId || canonicalSession.metadata?.beutlUserId !== current.ownerUserId || canonicalSession.metadata?.billingOfferId !== current.billingOfferId) throw new Error("Canonical Checkout Session identity mismatch");
        if (canonicalSession.status === "expired") {
          proof = { kind: "session-expired", sessionId: canonicalSession.id, status: "expired" };
        } else {
          const paymentIntentId = typeof canonicalSession.payment_intent === "string"
            ? canonicalSession.payment_intent
            : canonicalSession.payment_intent?.id;
          if (canonicalSession.status !== "complete" || !paymentIntentId) throw new Error("Canonical Checkout Session remains unsettled");
          proof = await verifyCanonicalPaymentIntent(
            stripe,
            paymentIntentId,
            current,
            canonicalSession.id,
          );
        }
      } else {
        const discovery = await discoverTopUpCheckoutAttempt({
          stripe,
          customerId: current.stripeCustomerId,
          userId: current.ownerUserId,
          attemptId: current.topUpAttemptId,
          billingOfferId: current.billingOfferId,
        });
        const checkedAt = new Date();
        if (discovery.status === "none") {
          const firstObservedAt = current.operatorAbsenceObservedAt;
          if (
            !firstObservedAt ||
            checkedAt.getTime() - firstObservedAt.getTime() <
              TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS
          ) {
            const observedAt = firstObservedAt ?? checkedAt;
            const recorded = await recordTopUpCheckoutResolutionAbsenceObservation({
              topUpAttemptId: current.topUpAttemptId,
              leaseToken,
              expectedRevision: current.revision,
              observedAt,
            });
            if (recorded.count !== 1) throw new Error("Top-up absence observation lease lost");
            releaseLease = false;
            return {
              success: true,
              message: `First Stripe absence observation recorded; retry after ${new Date(observedAt.getTime() + TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS).toISOString()}`,
            };
          }
          proof = {
            kind: "discovery-absent",
            firstObservedAt: firstObservedAt.toISOString(),
            checkedAt: checkedAt.toISOString(),
          };
        } else {
          const sessions = discovery.status === "single"
            ? [discovery.session]
            : discovery.sessions;
          const settled: Array<{ id: string; status: "expired" } | { id: string; status: "complete"; paymentProof: import("@beutl/db").PaymentIntentResolutionProof }> = [];
          for (const listed of sessions) {
            let item = listed;
            if (listed.status === "open") {
              const renewed = await renewTopUpCheckoutResolutionOperatorLease({
                topUpAttemptId: current.topUpAttemptId,
                leaseToken,
                expectedRevision: current.revision,
                now: new Date(),
                leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
              });
              if (!renewed) throw new Error("Top-up operator lease was lost before Session expiration");
              item = await stripe.checkout.sessions.expire(listed.id);
            }
            if (item.status === "expired") {
              settled.push({ id: item.id, status: "expired" });
              continue;
            }
            const paymentIntentId = typeof item.payment_intent === "string"
              ? item.payment_intent
              : item.payment_intent?.id;
            if (item.status !== "complete" || !paymentIntentId) throw new Error("Stripe discovery contains an unsettled completed Session");
            const paymentProof = await verifyCanonicalPaymentIntent(
              stripe,
              paymentIntentId,
              current,
              item.id,
            );
            settled.push({ id: item.id, status: "complete", paymentProof });
          }
          proof = {
            kind: "sessions-settled",
            sessions: settled.sort((left, right) => left.id.localeCompare(right.id)),
            checkedAt: checkedAt.toISOString(),
          };
        }
      }

      const renewed = await renewTopUpCheckoutResolutionOperatorLease({
        topUpAttemptId: current.topUpAttemptId,
        leaseToken,
        expectedRevision: current.revision,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      });
      if (!renewed) throw new Error("Top-up operator lease was lost before finalization");
      const result = await startRetryableTransaction(async (tx) => {
        const transition = await terminalizeTopUpCheckoutResolutionOnly({ topUpAttemptId: current!.topUpAttemptId, ownerUserId: current!.ownerUserId, stripeCustomerId: current!.stripeCustomerId, billingOfferId: current!.billingOfferId, expectedRevision: current!.revision, operatorUserId: session.user.id, operatorReason: value.operatorReason as string, operatorEvidence: value.operatorEvidence as string, proof, operatorLeaseToken: leaseToken, prisma: tx });
        if (transition.status === "conflict" || transition.status === "unsafe") return transition;
        await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.topUpCheckoutInterventionTerminalized, details: `resolution-only attemptId: ${value.topUpAttemptId}, revision: ${value.expectedRevision}->${transition.revision}`, prisma: tx });
        return transition;
      });
      if (result.status !== "terminalized") {
        await releaseTopUpCheckoutResolutionOperatorLease({ topUpAttemptId: current.topUpAttemptId, leaseToken, expectedRevision: current.revision, absenceObservedAt: null });
        releaseLease = false;
      }
      return result.status === "terminalized" ? { success: true, message: "Orphan top-up resolution terminalized" } : { success: false, message: result.status === "unsafe" ? result.reason : "Resolution changed; reload and retry" };
    } catch (error) {
      if (current && releaseLease) await releaseTopUpCheckoutResolutionOperatorLease({ topUpAttemptId: current.topUpAttemptId, leaseToken, expectedRevision: current.revision, absenceObservedAt: null });
      return {
        success: false,
        message: error instanceof Error ? error.message : "Stripe verification failed",
      };
    }
  });
}

// Nothing but Server Actions may be exported from this file — not even a type.
// Turbopack walks every export at runtime to register the actions, so a
// re-exported type is evaluated as a value and throws. Callers import the
// change types from @/lib/ai-configuration-changes instead.

// The whole AI configuration is saved at once: the allowance and every
// operation's list of models, in one transaction.
//
// Committing them separately made every ordering between them a state someone
// could be looking at — an allowance saved before the model it was raised for
// is an operation nobody can start — and left the page with two save
// mechanisms for one screen.
export async function saveAiConfiguration(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Validation reads inside the transaction because it is a cross-field rule
    // over state this save does not carry: the settings and operations it
    // leaves alone take part in it, so checking against a snapshot read
    // beforehand lets two saves each pass against a state the other
    // invalidates. Read together, the write conflict is one
    // startRetryableTransaction already retries.
    const outcome = await startRetryableTransaction(async (tx) => {
      const [current, catalog, storedRows] = await Promise.all([
        loadAiSettings({ prisma: tx }),
        loadAiModelCatalog({ prisma: tx }),
        listAiOperationModels({ prisma: tx }),
      ]);
      const stored = new Map(
        current.all().map((setting) => [setting.key, setting.value]),
      );

      const validated = validateAiConfigurationChanges(input, {
        currentSettingValueOf: (key) => stored.get(key) ?? "",
        storedModelsOf: (operation) =>
          catalog
            .list(operation)
            .map((entry) => ({ priceUnits: entry.priceUnits, enabled: true })),
        builtInModelsOf: (operation) => {
          const defaults = (
            AI_DEFAULT_OPERATION_MODELS as Record<string, { price: number }>
          )[operation];
          return defaults
            ? [{ priceUnits: defaults.price, enabled: true }]
            : [];
        },
        minimumChargeOf: (operation, priceUnits) =>
          aiMinimumChargeOf(operation, priceUnits) ?? priceUnits,
      });
      if (!validated.ok) {
        return { ok: false as const, message: validated.message };
      }

      // These values decide what users are charged, so record who changed what,
      // one entry per setting and per model so the log stays greppable.
      for (const change of validated.settings) {
        if (change.value === null) {
          await deleteAiSetting({ key: change.key, prisma: tx });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiSettingReset,
            details: `key: ${change.key}`,
            prisma: tx,
          });
          continue;
        }
        await upsertAiSetting({
          key: change.key,
          value: change.value,
          updatedBy: session.user.id,
          prisma: tx,
        });
        await addAuditLog({
          userId: session.user.id,
          action: auditLogActions.admin.aiSettingChanged,
          details: `key: ${change.key}, value: ${change.value}`,
          prisma: tx,
        });
      }

      for (const draft of validated.models) {
        const existing = storedRows.filter(
          (row) => row.operation === draft.operation,
        );
        const submitted = new Set(draft.models.map((model) => model.modelId));
        for (const row of existing) {
          if (submitted.has(row.modelId)) continue;
          await deleteAiOperationModel({
            operation: draft.operation,
            modelId: row.modelId,
            prisma: tx,
          });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiOperationModelRemoved,
            details: `operation: ${draft.operation}, model: ${row.modelId}`,
            prisma: tx,
          });
        }

        for (const [index, model] of draft.models.entries()) {
          const before = existing.find((row) => row.modelId === model.modelId);
          const unchanged =
            before !== undefined &&
            before.priceUnits === model.priceUnits &&
            before.displayName === model.displayName &&
            before.enabled === model.enabled &&
            before.sortOrder === index;
          if (unchanged) continue;
          // The submitted order is the display order, and its first entry is
          // what a request that names no model runs on.
          await upsertAiOperationModel({
            ...model,
            sortOrder: index,
            updatedBy: session.user.id,
            prisma: tx,
          });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiOperationModelSaved,
            details: `operation: ${draft.operation}, model: ${model.modelId}, price: ${model.priceUnits}, order: ${index}, enabled: ${model.enabled}`,
            prisma: tx,
          });
        }
      }

      return { ok: true as const };
    });
    if (!outcome.ok) {
      return { success: false, message: outcome.message };
    }
    revalidatePath("/[lang]/admin/ai", "page");

    return { success: true };
  });
}

// What one model would cost to run, for a row being added or edited.
//
// The saved rows get their figures rendered on the server, but a model that is
// only typed into the form has none: the provider's rate card is keyed by model
// id, so there is nothing to look up until the id exists. Without this the one
// number worth knowing while choosing a price — what share of it goes to the
// provider — appears only after the price is already saved.
export async function lookupAiModelEconomics(input: unknown) {
  if (typeof input !== "object" || input === null) {
    return { success: false as const, message: "Invalid model" };
  }
  const { operation, modelId } = input as Record<string, unknown>;
  if (typeof operation !== "string" || !isAiModelId(modelId)) {
    return { success: false as const, message: "Invalid model" };
  }

  return await adminAction(async () => {
    // Both go over the network. The rate card is cached per URL path and the
    // Stripe prices per request, so retyping an id costs one fetch at most.
    const prisma = await getDb();
    const [costs, pro, topUp] = await Promise.all([
      loadAiCostEstimates({ modelsOf: () => [modelId] }),
      resolveOfferPricing({ kind: "pro", prisma }),
      resolveOfferPricing({ kind: "top_up", prisma }),
    ]);

    return {
      success: true as const,
      estimate:
        costs.entries.find(
          (entry) =>
            aiCostEstimateKey(entry.operation, entry.model) ===
            aiCostEstimateKey(operation, modelId),
        )?.estimate ?? null,
      proOffer: pro.effective
        ? {
            unitAmount: pro.effective.unitAmount,
            currency: pro.effective.currency,
            creditAmount: pro.effective.creditAmount,
          }
        : null,
      topUpUnitValue: deriveTopUpUnitValue(topUp.effective),
    };
  });
}
