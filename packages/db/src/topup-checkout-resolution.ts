import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { scheduleTopUpDuplicateRefundAttempt } from "./topup-duplicate-refund-attempt";
import {
  fulfillTopUpCheckoutAttempt,
} from "./top-up-checkout-attempt";
import type { StripePaymentDetails } from "./credit-account";

type TopUpCheckoutResolutionStatus = "refund_pending" | "intervention" | "resolved" | "terminal";
export const TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS = 5 * 60_000;

type TopUpCheckoutResolutionOperatorState = {
  operatorLeaseToken: string | null;
  operatorLeaseExpiresAt: Date | null;
  operatorAbsenceObservedAt: Date | null;
};

function withOperatorState<T extends object>(
  value: T | null,
): (T & TopUpCheckoutResolutionOperatorState) | null {
  return value as (T & TopUpCheckoutResolutionOperatorState) | null;
}

export async function recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, canonicalPaymentIntentId, expectedPaymentIntentIds, status = "refund_pending", lastError, expectedRevision, prisma }: { topUpAttemptId: string; ownerUserId: string; stripeCustomerId: string; billingOfferId: string; canonicalSessionId?: string | null; canonicalPaymentIntentId?: string | null; expectedPaymentIntentIds: string[]; status?: TopUpCheckoutResolutionStatus; lastError?: string; expectedRevision?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const table = db.topUpCheckoutResolution;
  const expected = JSON.stringify([...new Set(expectedPaymentIntentIds)].sort());
  const existing = await table.findUnique({ where: { topUpAttemptId } });
  if (existing) {
    if (existing.ownerUserId !== ownerUserId || existing.stripeCustomerId !== stripeCustomerId || existing.billingOfferId !== billingOfferId || (existing.canonicalSessionId && canonicalSessionId && existing.canonicalSessionId !== canonicalSessionId) || (existing.canonicalPaymentIntentId && canonicalPaymentIntentId && existing.canonicalPaymentIntentId !== canonicalPaymentIntentId)) throw new Error("Top-up resolution identity conflict");
    if (existing.status === "resolved" || existing.status === "terminal") return existing;
    const old = JSON.parse(existing.expectedPaymentIntentIds) as string[];
    const union = [...new Set([...old, ...JSON.parse(expected)])];
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) throw new Error("Top-up resolution revision conflict");
    const updated = await table.updateMany({ where: { id: existing.id, revision: existing.revision }, data: { canonicalSessionId: existing.canonicalSessionId ?? canonicalSessionId ?? null, canonicalPaymentIntentId: existing.canonicalPaymentIntentId ?? canonicalPaymentIntentId ?? null, expectedPaymentIntentIds: JSON.stringify(union), status, lastError: lastError ?? existing.lastError, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Top-up resolution revision CAS lost");
    return await table.findUnique({ where: { id: existing.id } });
  }
  try { return await table.create({ data: { topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId: canonicalSessionId ?? null, canonicalPaymentIntentId: canonicalPaymentIntentId ?? null, expectedPaymentIntentIds: expected, status, lastError: lastError ?? null } }); } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const raced = await table.findUnique({ where: { topUpAttemptId } });
    if (!raced) throw error;
    return await recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, canonicalPaymentIntentId, expectedPaymentIntentIds, status, lastError, expectedRevision: raced.revision, prisma });
  }
}


export async function topUpCheckoutResolutionRefundState({ topUpAttemptId, prisma }: { topUpAttemptId: string; prisma?: PrismaTransaction }): Promise<"none" | "pending" | "intervention" | "settled"> {
  const db = prisma ?? await getDb();
  const resolution = await db.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
  if (!resolution) return "none";
  if (resolution.status !== "refund_pending") return resolution.status === "resolved" ? "settled" : resolution.status === "intervention" ? "intervention" : "none";
  const ids = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
  if (ids.length === 0) {
    return resolution.canonicalSessionId ? "settled" : "none";
  }
  const rows = await db.topUpDuplicateRefundAttempt.findMany({ where: { stripePaymentIntentId: { in: ids } }, select: { stripePaymentIntentId: true, status: true, amount: true, refundedAmount: true } });
  if (rows.some((row) => row.status === "intervention")) return "intervention";
  return ids.every((id) => rows.some((row) => row.stripePaymentIntentId === id && row.status === "refunded" && row.refundedAmount === row.amount)) ? "settled" : "pending";
}


export async function markTopUpResolutionAndAttemptIntervention({ topUpAttemptId, recoveryLeaseToken, lastError, prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
    if (!resolution || resolution.status !== "refund_pending") return false;
    const updatedAttempt = await tx.topUpCheckoutAttempt.updateMany({ where: { id: topUpAttemptId, recoveryLeaseToken, createLeaseToken: recoveryLeaseToken, stripeCheckoutSessionId: null }, data: { recoveryInterventionAt: new Date(), recoveryLastError: lastError, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, createLeaseToken: null, createLeaseExpiresAt: null } });
    if (updatedAttempt.count !== 1) throw new Error("Top-up intervention attempt CAS lost");
    const updated = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, revision: resolution.revision, status: "refund_pending" }, data: { status: "intervention", lastError, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Top-up intervention resolution CAS lost");
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function scheduleTopUpCheckoutResolution({ topUpAttemptId, recoveryLeaseToken, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, canonicalPaymentIntentId, expectedPaymentIntents, now = new Date(), prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; ownerUserId: string; stripeCustomerId: string; billingOfferId: string; canonicalSessionId: string | null; canonicalPaymentIntentId: string | null; expectedPaymentIntents: Array<{ paymentIntentId: string; amount: number; currency: string }>; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findFirst({ where: { id: topUpAttemptId, recoveryLeaseToken, createLeaseToken: recoveryLeaseToken, stripeCheckoutSessionId: null }, select: { id: true } });
    if (!attempt) throw new Error("Top-up resolution recovery lease lost");
    const current = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
    const oldIds = current ? JSON.parse(current.expectedPaymentIntentIds) as string[] : [];
    const union = [...new Set([...oldIds, ...expectedPaymentIntents.map((item) => item.paymentIntentId)])];
    const row = await recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, canonicalPaymentIntentId, expectedPaymentIntentIds: union, expectedRevision: current?.revision, status: "refund_pending", prisma: tx });
    for (const payment of expectedPaymentIntents.filter((item) => !oldIds.includes(item.paymentIntentId))) await scheduleTopUpDuplicateRefundAttempt({ topUpAttemptId, stripePaymentIntentId: payment.paymentIntentId, stripeCustomerId, ownerUserId, billingOfferId, amount: payment.amount, currency: payment.currency, prisma: tx });
    return row;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function getTopUpCheckoutResolution({ topUpAttemptId, prisma }: { topUpAttemptId: string; prisma?: PrismaTransaction }) { return await (prisma ?? await getDb()).topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }); }

export async function claimTopUpCheckoutResolutionOperatorLease({ topUpAttemptId, expectedRevision, leaseToken, leaseExpiresAt, now = new Date(), prisma }: { topUpAttemptId: string; expectedRevision: number; leaseToken: string; leaseExpiresAt: Date; now?: Date; prisma?: PrismaTransaction }) {
  if (!leaseToken || leaseExpiresAt.getTime() <= now.getTime()) return null;
  const db = prisma ?? await getDb();
  const attempt = await db.topUpCheckoutAttempt.findUnique({ where: { id: topUpAttemptId }, select: { status: true } });
  if (attempt && !["expired", "refunded", "refund_not_required"].includes(attempt.status)) return null;
  const updated = await db.topUpCheckoutResolution.updateMany({ where: { topUpAttemptId, status: "intervention", revision: expectedRevision, OR: [{ operatorLeaseExpiresAt: null }, { operatorLeaseExpiresAt: { lte: now } }] } as never, data: { operatorLeaseToken: leaseToken, operatorLeaseExpiresAt: leaseExpiresAt, revision: { increment: 1 } } as never });
  if (updated.count !== 1) return null;
  return withOperatorState(await db.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
}

export async function releaseTopUpCheckoutResolutionOperatorLease({ topUpAttemptId, leaseToken, expectedRevision, absenceObservedAt, now = new Date(), prisma }: { topUpAttemptId: string; leaseToken: string; expectedRevision: number; absenceObservedAt?: Date | null; now?: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutResolution.updateMany({ where: { topUpAttemptId, status: "intervention", revision: expectedRevision, operatorLeaseToken: leaseToken } as never, data: { operatorLeaseToken: null, operatorLeaseExpiresAt: null, ...(absenceObservedAt === undefined ? {} : { operatorAbsenceObservedAt: absenceObservedAt }), revision: { increment: 1 }, updatedAt: now } as never });
}

export async function recordTopUpCheckoutResolutionAbsenceObservation({ topUpAttemptId, leaseToken, expectedRevision, observedAt, prisma }: { topUpAttemptId: string; leaseToken: string; expectedRevision: number; observedAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutResolution.updateMany({
    where: { topUpAttemptId, status: "intervention", revision: expectedRevision, operatorLeaseToken: leaseToken, operatorLeaseExpiresAt: { gt: observedAt } } as never,
    data: {
      operatorAbsenceObservedAt: observedAt,
      operatorLeaseExpiresAt: new Date(observedAt.getTime() + TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS),
      lastError: "First exhaustive Stripe absence observation recorded; confirmation is required",
      revision: { increment: 1 },
    } as never,
  });
}

export async function renewTopUpCheckoutResolutionOperatorLease({ topUpAttemptId, leaseToken, expectedRevision, now = new Date(), leaseExpiresAt, prisma }: { topUpAttemptId: string; leaseToken: string; expectedRevision: number; now?: Date; leaseExpiresAt: Date; prisma?: PrismaTransaction }) {
  if (leaseExpiresAt.getTime() <= now.getTime()) return false;
  const db = prisma ?? await getDb();
  const renewed = await db.topUpCheckoutResolution.updateMany({
    where: { topUpAttemptId, status: "intervention", revision: expectedRevision, operatorLeaseToken: leaseToken, operatorLeaseExpiresAt: { gt: now } } as never,
    data: { operatorLeaseExpiresAt: leaseExpiresAt } as never,
  });
  return renewed.count === 1;
}

/** List every operator intervention, including legacy resolution rows whose
 * attempt was deleted. This is intentionally global (admin-only callers) so
 * an orphan cannot become an invisible account-deletion blocker. */
export async function listTopUpCheckoutInterventions({ prisma }: { prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? await getDb();
  const rows = await db.topUpCheckoutResolution.findMany({
    where: { status: "intervention" },
    orderBy: { updatedAt: "asc" },
  });
  return await Promise.all(rows.map(async (resolution) => ({
    resolution,
    attempt: await db.topUpCheckoutAttempt.findUnique({ where: { id: resolution.topUpAttemptId } }),
  })));
}

export async function findTopUpCheckoutIntervention({ ownerUserId, prisma }: { ownerUserId: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempts = await tx.topUpCheckoutAttempt.findMany({
      where: { ownerUserId, recoveryInterventionAt: { not: null } },
      orderBy: [{ updatedAt: "asc" }],
    });
    // Do not lazily create a resolution here. This read path is used by the
    // admin page and may run outside the writer transaction; creating a row
    // would race markDetached and could hide a later marker. The writer path
    // now enforces the one-marker/one-resolution invariant.
    for (const attempt of attempts) {
      const resolution = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId: attempt.id } });
      if (!resolution) {
        // Legacy marker without a resolution is not actionable from this
        // endpoint. Skip it and continue so a later valid intervention is not
        // hidden by an inconsistent first row.
        continue;
      }
      if (resolution.status === "intervention") return { attempt, resolution };
    }
    return null;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

type TopUpInterventionIdentity = {
  topUpAttemptId: string;
  ownerUserId: string;
  stripeCustomerId: string;
  billingOfferId: string;
  expectedRevision: number;
  expectedInterventionAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
};

export type TopUpOperatorEvidence = {
  operatorUserId: string;
  operatorReason: string;
  operatorEvidence: string;
};

export type PaymentIntentResolutionProof =
  | { kind: "payment-intent-refunded"; paymentIntentId: string; sessionId?: string; status: string; amountReceived: number; refundedAmount: number; refundIds: string[]; currency: string }
  | { kind: "payment-intent-unpaid"; paymentIntentId: string; sessionId?: string; status: "canceled"; amountReceived: 0; currency: string };

export type CanonicalResolutionProof =
  | { kind: "discovery-absent"; firstObservedAt: string; checkedAt: string }
  | { kind: "sessions-settled"; sessions: Array<{ id: string; status: "expired" } | { id: string; status: "complete"; paymentProof: PaymentIntentResolutionProof }>; checkedAt: string }
  | { kind: "session-expired"; sessionId: string; status: "expired" }
  | PaymentIntentResolutionProof;

function paymentIntentProofIsSettled(proof: PaymentIntentResolutionProof): boolean {
  return proof.kind === "payment-intent-refunded"
    ? proof.status === "succeeded" &&
      proof.amountReceived > 0 &&
      proof.refundedAmount >= proof.amountReceived
    : proof.status === "canceled" && proof.amountReceived === 0;
}

/** Resume an operator-paused recovery with an exact identity and revision CAS. */
export async function resumeTopUpCheckoutIntervention({
  topUpAttemptId,
  ownerUserId,
  stripeCustomerId,
  billingOfferId,
  expectedRevision,
  expectedInterventionAt,
  now = new Date(),
  prisma,
}: TopUpInterventionIdentity) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
    if (!resolution || resolution.status !== "intervention" || resolution.revision !== expectedRevision || resolution.ownerUserId !== ownerUserId || resolution.stripeCustomerId !== stripeCustomerId || resolution.billingOfferId !== billingOfferId) return { status: "conflict" as const };
    if (resolution.operatorLeaseToken && resolution.operatorLeaseExpiresAt && resolution.operatorLeaseExpiresAt > now) return { status: "conflict" as const };
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: topUpAttemptId } });
    if (!attempt || attempt.ownerUserId !== ownerUserId || attempt.stripeCustomerId !== stripeCustomerId || attempt.billingOfferId !== billingOfferId || attempt.stripeCheckoutSessionId !== null || attempt.recoveryInterventionAt?.getTime() !== expectedInterventionAt.getTime()) return { status: "conflict" as const };
    if (["fulfilled", "expired", "refunded", "refund_not_required"].includes(attempt.status)) return { status: "unsafe" as const, reason: "A terminal attempt cannot be resumed" };
    const resumed = await tx.topUpCheckoutAttempt.updateMany({ where: { id: topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, stripeCheckoutSessionId: null, recoveryInterventionAt: expectedInterventionAt, updatedAt: attempt.updatedAt }, data: { ...(attempt.accountDeletionAt !== null && ["open", "payment_pending"].includes(attempt.status) ? { status: "refund_required", refundNotBefore: now } : {}), recoveryInterventionAt: null, recoveryAttempts: 0, recoveryLastError: null, recoveryNotBefore: now } });
    if (resumed.count !== 1) return { status: "conflict" as const };
    const updated = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, status: "intervention", revision: expectedRevision }, data: ({ status: "refund_pending", lastError: null, operatorLeaseToken: null, operatorLeaseExpiresAt: null, operatorAbsenceObservedAt: null, revision: { increment: 1 } } as never) });
    if (updated.count !== 1) throw new Error("Top-up intervention revision CAS lost");
    return { status: "resumed" as const, revision: expectedRevision + 1 };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

/** Terminalize an intervention after an operator has confirmed no payment is owed. */
export async function terminalizeTopUpCheckoutIntervention({
  topUpAttemptId,
  ownerUserId,
  stripeCustomerId,
  billingOfferId,
  expectedRevision,
  expectedInterventionAt,
  now = new Date(),
  operatorUserId,
  operatorReason,
  operatorEvidence,
  prisma,
}: TopUpInterventionIdentity & TopUpOperatorEvidence) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
    if (!resolution || resolution.status !== "intervention" || resolution.revision !== expectedRevision || resolution.ownerUserId !== ownerUserId || resolution.stripeCustomerId !== stripeCustomerId || resolution.billingOfferId !== billingOfferId) return { status: "conflict" as const };
    if (resolution.operatorLeaseToken && resolution.operatorLeaseExpiresAt && resolution.operatorLeaseExpiresAt > now) return { status: "conflict" as const };
    if (typeof operatorReason !== "string" || typeof operatorEvidence !== "string" || !operatorReason.trim() || !operatorEvidence.trim()) return { status: "unsafe" as const, reason: "Operator reason and evidence are required" };
    const expectedIds = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
    if (resolution.canonicalSessionId || resolution.canonicalPaymentIntentId || expectedIds.length > 0) return { status: "unsafe" as const, reason: "Stripe checkout or PaymentIntent evidence still requires refund or reconciliation" };
    const refunds = await tx.topUpDuplicateRefundAttempt.findMany({
      where: { topUpAttemptId },
      select: { status: true, amount: true, refundedAmount: true },
    });
    if (refunds.some((refund) =>
      refund.status !== "refunded" || refund.refundedAmount !== refund.amount)) {
      return { status: "unsafe" as const, reason: "Outstanding refund work must be settled before terminalization" };
    }
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: topUpAttemptId } });
    if (!attempt || attempt.ownerUserId !== ownerUserId || attempt.stripeCustomerId !== stripeCustomerId || attempt.billingOfferId !== billingOfferId || attempt.stripeCheckoutSessionId !== null || attempt.recoveryInterventionAt?.getTime() !== expectedInterventionAt.getTime()) return { status: "conflict" as const };
    if (attempt.stripePaymentIntentId || attempt.refundId || attempt.refundStatus || (attempt.refundTargetAmount ?? 0) > 0 || attempt.refundSucceededAmount > 0 || attempt.refundPendingAmount > 0 || attempt.refundCurrency || attempt.fulfilledAt) return { status: "unsafe" as const, reason: "Attempt-side payment or refund evidence still requires reconciliation" };
    const purchase = await tx.creditTransaction.findFirst({
      where: { topUpCheckoutAttemptId: topUpAttemptId },
      select: { id: true },
    });
    if (purchase) return { status: "unsafe" as const, reason: "Credit purchase ledger evidence still requires reconciliation" };
    const nextStatus = attempt.accountDeletionAt === null ? "expired" : "refund_not_required";
    const terminal = await tx.topUpCheckoutAttempt.updateMany({ where: { id: topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, stripeCheckoutSessionId: null, recoveryInterventionAt: expectedInterventionAt, updatedAt: attempt.updatedAt }, data: { status: nextStatus, activeOwnerKey: null, recoveryInterventionAt: null, recoveryAttempts: 0, recoveryLastError: null, recoveryNotBefore: null } });
    if (terminal.count !== 1) return { status: "conflict" as const };
    const updated = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, status: "intervention", revision: expectedRevision }, data: ({ status: "terminal", lastError: null, operatorUserId, operatorReason: operatorReason.trim(), operatorEvidence: operatorEvidence.trim(), operatorActionAt: now, operatorLeaseToken: null, operatorLeaseExpiresAt: null, operatorAbsenceObservedAt: null, revision: { increment: 1 } } as never) });
    if (updated.count !== 1) throw new Error("Top-up intervention revision CAS lost");
    return { status: "terminalized" as const, revision: expectedRevision + 1 };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

/** Terminalize an intervention when its attempt row is missing. Monetary
 * evidence is never discarded: all expected duplicate refunds must be
 * fully settled before the resolution-only CAS is allowed.
 */
export async function terminalizeTopUpCheckoutResolutionOnly({
  topUpAttemptId,
  ownerUserId,
  stripeCustomerId,
  billingOfferId,
  expectedRevision,
  operatorUserId,
  operatorReason,
  operatorEvidence,
  proof,
  operatorLeaseToken,
  now = new Date(),
  prisma,
}: {
  topUpAttemptId: string;
  ownerUserId: string;
  stripeCustomerId: string;
  billingOfferId: string;
  expectedRevision: number;
  operatorUserId: string;
  operatorReason: string;
  operatorEvidence: string;
  proof: CanonicalResolutionProof;
  operatorLeaseToken: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    if (!operatorReason.trim() || !operatorEvidence.trim()) return { status: "unsafe" as const, reason: "Operator reason and evidence are required" };
    const verifiedProof = proof;
    const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
    if (!resolution || resolution.status !== "intervention" || resolution.revision !== expectedRevision || resolution.ownerUserId !== ownerUserId || resolution.stripeCustomerId !== stripeCustomerId || resolution.billingOfferId !== billingOfferId) return { status: "conflict" as const };
    if (!operatorLeaseToken || resolution.operatorLeaseToken !== operatorLeaseToken || !resolution.operatorLeaseExpiresAt || resolution.operatorLeaseExpiresAt <= now) return { status: "conflict" as const };
    const expectedIds = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
    const refunds = await tx.topUpDuplicateRefundAttempt.findMany({ where: { topUpAttemptId }, select: { stripePaymentIntentId: true, status: true, refundedAmount: true, amount: true, refundId: true } });
    if (resolution.canonicalPaymentIntentId) {
      const verified = (verifiedProof.kind === "payment-intent-refunded" ||
          verifiedProof.kind === "payment-intent-unpaid") &&
        verifiedProof.paymentIntentId === resolution.canonicalPaymentIntentId &&
        paymentIntentProofIsSettled(verifiedProof);
      if (!verified) return { status: "unsafe" as const, reason: "Canonical PaymentIntent proof does not establish an unpaid or full-refund outcome" };
    } else if (resolution.canonicalSessionId) {
      const verified = verifiedProof.kind === "session-expired"
        ? verifiedProof.sessionId === resolution.canonicalSessionId &&
          verifiedProof.status === "expired"
        : (verifiedProof.kind === "payment-intent-refunded" ||
            verifiedProof.kind === "payment-intent-unpaid") &&
          verifiedProof.sessionId === resolution.canonicalSessionId &&
          paymentIntentProofIsSettled(verifiedProof);
      if (!verified) return { status: "unsafe" as const, reason: "Canonical Session proof does not match resolution" };
    } else if (verifiedProof.kind === "sessions-settled") {
      if (verifiedProof.sessions.length === 0 || verifiedProof.sessions.some((session) =>
        session.status === "complete" &&
        (session.paymentProof.sessionId !== session.id ||
          !paymentIntentProofIsSettled(session.paymentProof)))) {
        return { status: "unsafe" as const, reason: "Discovered completed Sessions lack full server-verified settlement proof" };
      }
    } else if (verifiedProof.kind === "discovery-absent") {
      const firstObservedAt = new Date(verifiedProof.firstObservedAt);
      const checkedAt = new Date(verifiedProof.checkedAt);
      if (
        !resolution.operatorAbsenceObservedAt ||
        !Number.isFinite(firstObservedAt.getTime()) ||
        !Number.isFinite(checkedAt.getTime()) ||
        resolution.operatorAbsenceObservedAt.getTime() !== firstObservedAt.getTime() ||
        checkedAt.getTime() - firstObservedAt.getTime() <
          TOP_UP_OPERATOR_ABSENCE_CONFIRMATION_MS ||
        Math.abs(now.getTime() - checkedAt.getTime()) > 60_000
      ) {
        return { status: "unsafe" as const, reason: "Two separated exhaustive absence observations are required" };
      }
    } else {
      return { status: "unsafe" as const, reason: "A no-handle resolution requires a server-verified discovery proof" };
    }
    if (expectedIds.some((id) => !refunds.some((row) => row.stripePaymentIntentId === id && row.status === "refunded" && row.refundedAmount === row.amount))) return { status: "unsafe" as const, reason: "Expected refunds are not settled in full" };
    if (refunds.some((row) => row.status !== "refunded" || row.refundedAmount !== row.amount)) return { status: "unsafe" as const, reason: "Additional refund work is not settled in full" };
    if (verifiedProof.kind === "payment-intent-refunded") {
      const refundIds = refunds.filter((row) =>
        row.stripePaymentIntentId === verifiedProof.paymentIntentId)
        .map((row) => row.refundId)
        .filter((id): id is string => Boolean(id));
      if (refundIds.some((id) => !verifiedProof.refundIds.includes(id))) return { status: "unsafe" as const, reason: "Canonical refund proof omits a recorded refund" };
    }
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: topUpAttemptId } });
    if (attempt) {
      if (attempt.ownerUserId !== ownerUserId || attempt.stripeCustomerId !== stripeCustomerId || attempt.billingOfferId !== billingOfferId) return { status: "conflict" as const };
      if (!["expired", "refunded", "refund_not_required"].includes(attempt.status)) return { status: "unsafe" as const, reason: "An active attempt must be reconciled by its normal recovery path" };
      const purchase = await tx.creditTransaction.findFirst({ where: { topUpCheckoutAttemptId: topUpAttemptId }, select: { id: true } });
      if (purchase) return { status: "unsafe" as const, reason: "Credit purchase ledger evidence still requires reconciliation" };
      const fullyRefunded = attempt.status === "refunded" &&
        (attempt.refundTargetAmount ?? 0) > 0 &&
        attempt.refundSucceededAmount === attempt.refundTargetAmount &&
        attempt.refundPendingAmount === 0;
      const sessionCovered = !attempt.stripeCheckoutSessionId ||
        resolution.canonicalSessionId === attempt.stripeCheckoutSessionId ||
        (verifiedProof.kind === "session-expired" &&
          verifiedProof.sessionId === attempt.stripeCheckoutSessionId) ||
        ((verifiedProof.kind === "payment-intent-refunded" ||
            verifiedProof.kind === "payment-intent-unpaid") &&
          verifiedProof.sessionId === attempt.stripeCheckoutSessionId) ||
        (verifiedProof.kind === "sessions-settled" &&
          verifiedProof.sessions.some((item) =>
            item.id === attempt.stripeCheckoutSessionId));
      const terminalWithoutMoney =
        (attempt.status === "expired" ||
          attempt.status === "refund_not_required") &&
        !attempt.stripePaymentIntentId &&
        !attempt.refundId &&
        !attempt.fulfilledAt &&
        (attempt.refundTargetAmount ?? 0) === 0 &&
        attempt.refundSucceededAmount === 0 &&
        attempt.refundPendingAmount === 0 &&
        !attempt.refundCurrency &&
        (attempt.refundStatus === null ||
          attempt.refundStatus === "not_required") &&
        sessionCovered;
      const hasAttemptMoney = Boolean(
        attempt.stripePaymentIntentId || attempt.stripeCheckoutSessionId ||
        attempt.refundId || attempt.refundStatus || attempt.fulfilledAt ||
        (attempt.refundTargetAmount ?? 0) > 0 || attempt.refundSucceededAmount > 0 ||
        attempt.refundPendingAmount > 0 || attempt.refundCurrency,
      );
      if (hasAttemptMoney && !fullyRefunded && !terminalWithoutMoney) return { status: "unsafe" as const, reason: "Attempt-side payment evidence still requires reconciliation" };
      if (attempt.recoveryInterventionAt !== null) {
        const updatedAttempt = await tx.topUpCheckoutAttempt.updateMany({ where: { id: attempt.id, updatedAt: attempt.updatedAt, recoveryInterventionAt: attempt.recoveryInterventionAt }, data: { activeOwnerKey: null, recoveryInterventionAt: null, recoveryLastError: null, recoveryNotBefore: null } });
        if (updatedAttempt.count !== 1) return { status: "conflict" as const };
      }
    }
    const updated = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, status: "intervention", revision: expectedRevision, operatorLeaseToken } as never, data: ({ status: "terminal", lastError: null, operatorUserId, operatorReason: operatorReason.trim(), operatorEvidence: JSON.stringify({ text: operatorEvidence.trim(), canonicalProof: verifiedProof }), operatorActionAt: now, operatorLeaseToken: null, operatorLeaseExpiresAt: null, operatorAbsenceObservedAt: null, revision: { increment: 1 } } as never) });
    if (updated.count !== 1) throw new Error("Top-up resolution-only terminalization CAS lost");
    return { status: "terminalized" as const, revision: expectedRevision + 1 };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function resumeSettledTopUpCheckoutInterventions({
  now,
  limit = 50,
}: {
  now: Date;
  limit?: number;
}): Promise<number> {
  const db = await getDb();
  const candidates = await db.topUpCheckoutResolution.findMany({
    where: { status: "intervention" },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { topUpAttemptId: true },
  });
  let resumed = 0;
  for (const candidate of candidates) {
    const didResume = await startRetryableTransaction(async (tx) => {
      const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({
        where: { topUpAttemptId: candidate.topUpAttemptId },
      }));
      if (resolution?.status !== "intervention") return false;
      if (resolution.operatorLeaseToken && resolution.operatorLeaseExpiresAt && resolution.operatorLeaseExpiresAt > now) return false;
      const expectedIds = JSON.parse(
        resolution.expectedPaymentIntentIds,
      ) as string[];
      if (expectedIds.length === 0) return false;
      const refunds = await tx.topUpDuplicateRefundAttempt.findMany({
        where: { stripePaymentIntentId: { in: expectedIds } },
        select: { stripePaymentIntentId: true, status: true, amount: true, refundedAmount: true },
      });
      if (!expectedIds.every((paymentIntentId) => refunds.some((item) =>
        item.stripePaymentIntentId === paymentIntentId &&
        item.status === "refunded" && item.refundedAmount === item.amount))) return false;

      const attempt = await tx.topUpCheckoutAttempt.findUnique({
        where: { id: resolution.topUpAttemptId },
      });
      if (!attempt) {
        await tx.topUpCheckoutResolution.updateMany({
          where: {
            id: resolution.id,
            revision: resolution.revision,
            status: "intervention",
          },
          data: {
            lastError: "Refunds settled but the top-up attempt is missing",
            revision: { increment: 1 },
          },
        });
        return false;
      }
      const terminal = [
        "fulfilled",
        "expired",
        "refunded",
        "refund_not_required",
      ].includes(attempt.status);
      const nextStatus = attempt.stripeCheckoutSessionId !== null
        ? "resolved"
        : terminal ? "terminal" : "refund_pending";
      if (
        nextStatus === "refund_pending" &&
        attempt.recoveryInterventionAt !== null
      ) {
        const cleared = await tx.topUpCheckoutAttempt.updateMany({
          where: {
            id: attempt.id,
            updatedAt: attempt.updatedAt,
            recoveryInterventionAt: attempt.recoveryInterventionAt,
          },
          data: {
            recoveryInterventionAt: null,
            recoveryAttempts: 0,
            recoveryLastError: null,
            recoveryNotBefore: now,
          },
        });
        if (cleared.count !== 1) return false;
      }
      const updated = await tx.topUpCheckoutResolution.updateMany({
        where: {
          id: resolution.id,
          revision: resolution.revision,
          status: "intervention",
        },
        data: ({
          status: nextStatus,
          lastError: null,
          operatorLeaseToken: null,
          operatorLeaseExpiresAt: null,
          operatorAbsenceObservedAt: null,
          revision: { increment: 1 },
        } as never),
      });
      return updated.count === 1;
    });
    if (didResume) resumed++;
  }
  return resumed;
}

export type TopUpCheckoutFinalization =
  | { outcome: "bind"; sessionId: string; expiresAt: Date }
  | {
      outcome: "fulfill";
      sessionId: string;
      expiresAt: Date;
      paymentIntentId: string;
      stripePayment: StripePaymentDetails;
    }
  | { outcome: "terminal" };

export async function finalizeTopUpCheckoutResolutionAtomically({ topUpAttemptId, recoveryLeaseToken, finalization, prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; finalization: TopUpCheckoutFinalization; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = withOperatorState(await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }));
    if (!resolution || resolution.status !== "refund_pending") return false;
    if (resolution.operatorLeaseToken && resolution.operatorLeaseExpiresAt && resolution.operatorLeaseExpiresAt > new Date()) return false;
    const attempt = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: topUpAttemptId },
    });
    if (
      !attempt ||
      attempt.recoveryLeaseToken !== recoveryLeaseToken ||
      attempt.createLeaseToken !== recoveryLeaseToken ||
      attempt.stripeCheckoutSessionId !== null
    ) return false;
    if (
      finalization.outcome === "fulfill" &&
      (
        attempt.accountDeletionAt !== null ||
        resolution.canonicalPaymentIntentId !== finalization.paymentIntentId
      )
    ) {
      throw new Error("Top-up fulfillment finalization identity conflict");
    }
    const expectedIds = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
    if (expectedIds.length > 0) {
      const rows = await tx.topUpDuplicateRefundAttempt.findMany({ where: { stripePaymentIntentId: { in: expectedIds } }, select: { stripePaymentIntentId: true, status: true, amount: true, refundedAmount: true } });
      if (!expectedIds.every((id) => rows.some((row) => row.stripePaymentIntentId === id && row.status === "refunded" && row.refundedAmount === row.amount))) throw new Error("Top-up checkout resolution refunds are not settled");
    }
    const updatedAttempt = await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: topUpAttemptId,
        recoveryLeaseToken,
        createLeaseToken: recoveryLeaseToken,
        stripeCheckoutSessionId: null,
        updatedAt: attempt.updatedAt,
      },
      data: finalization.outcome === "bind" || finalization.outcome === "fulfill"
        ? {
            stripeCheckoutSessionId: finalization.sessionId,
            expiresAt: finalization.expiresAt,
            status: attempt.accountDeletionAt === null
              ? attempt.status
              : "refund_required",
            ...(attempt.accountDeletionAt === null
              ? {}
              : { refundNotBefore: new Date() }),
            recoveryLeaseToken: null,
            recoveryLeaseExpiresAt: null,
            createLeaseToken: null,
            createLeaseExpiresAt: null,
            recoveryNotBefore: null,
            recoveryLastError: null,
          }
        : {
            status: attempt.accountDeletionAt === null
              ? "expired"
              : "refund_not_required",
            activeOwnerKey: null,
            recoveryLeaseToken: null,
            recoveryLeaseExpiresAt: null,
            createLeaseToken: null,
            createLeaseExpiresAt: null,
            recoveryNotBefore: null,
            recoveryLastError: null,
          },
    });
    if (updatedAttempt.count !== 1) throw new Error("Top-up resolution attempt CAS lost");
    const updatedResolution = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, topUpAttemptId, revision: resolution.revision, status: "refund_pending" }, data: { status: finalization.outcome === "terminal" ? "terminal" : "resolved", revision: { increment: 1 } } });
    if (updatedResolution.count !== 1) throw new Error("Top-up resolution CAS lost");
    if (finalization.outcome === "fulfill") {
      const fulfillment = await fulfillTopUpCheckoutAttempt({
        attemptId: topUpAttemptId,
        stripePaymentIntentId: finalization.paymentIntentId,
        stripePayment: finalization.stripePayment,
        stripeRefundState: { succeededAmount: 0, pendingAmount: 0 },
        prisma: tx,
      });
      if (
        fulfillment.status !== "fulfilled" &&
        fulfillment.status !== "already-fulfilled"
      ) {
        throw new Error(
          `Top-up canonical fulfillment remained ${fulfillment.status}`,
        );
      }
    }
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}
