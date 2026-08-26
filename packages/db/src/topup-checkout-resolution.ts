import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { scheduleTopUpDuplicateRefundAttempt } from "./topup-duplicate-refund-attempt";

type TopUpCheckoutResolutionStatus = "refund_pending" | "intervention" | "resolved" | "terminal";

export async function recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, expectedPaymentIntentIds, status = "refund_pending", lastError, expectedRevision, prisma }: { topUpAttemptId: string; ownerUserId: string; stripeCustomerId: string; billingOfferId: string; canonicalSessionId?: string | null; expectedPaymentIntentIds: string[]; status?: TopUpCheckoutResolutionStatus; lastError?: string; expectedRevision?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const table = db.topUpCheckoutResolution;
  const expected = JSON.stringify([...new Set(expectedPaymentIntentIds)].sort());
  const existing = await table.findUnique({ where: { topUpAttemptId } });
  if (existing) {
    if (existing.ownerUserId !== ownerUserId || existing.stripeCustomerId !== stripeCustomerId || existing.billingOfferId !== billingOfferId || (existing.canonicalSessionId && canonicalSessionId && existing.canonicalSessionId !== canonicalSessionId)) throw new Error("Top-up resolution identity conflict");
    if (existing.status === "resolved" || existing.status === "terminal") return existing;
    const old = JSON.parse(existing.expectedPaymentIntentIds) as string[];
    const union = [...new Set([...old, ...JSON.parse(expected)])];
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) throw new Error("Top-up resolution revision conflict");
    const updated = await table.updateMany({ where: { id: existing.id, revision: existing.revision }, data: { canonicalSessionId: existing.canonicalSessionId ?? canonicalSessionId ?? null, expectedPaymentIntentIds: JSON.stringify(union), status, lastError: lastError ?? existing.lastError, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Top-up resolution revision CAS lost");
    return await table.findUnique({ where: { id: existing.id } });
  }
  try { return await table.create({ data: { topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId: canonicalSessionId ?? null, expectedPaymentIntentIds: expected, status, lastError: lastError ?? null } }); } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const raced = await table.findUnique({ where: { topUpAttemptId } });
    if (!raced) throw error;
    return await recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, expectedPaymentIntentIds, status, lastError, expectedRevision: raced.revision, prisma });
  }
}


export async function topUpCheckoutResolutionRefundState({ topUpAttemptId, prisma }: { topUpAttemptId: string; prisma?: PrismaTransaction }): Promise<"none" | "pending" | "intervention" | "settled"> {
  const db = prisma ?? await getDb();
  const resolution = await db.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
  if (!resolution) return "none";
  if (resolution.status !== "refund_pending") return resolution.status === "resolved" ? "settled" : resolution.status === "intervention" ? "intervention" : "none";
  const ids = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
  const rows = await db.topUpDuplicateRefundAttempt.findMany({ where: { stripePaymentIntentId: { in: ids } }, select: { stripePaymentIntentId: true, status: true } });
  if (rows.some((row) => row.status === "intervention")) return "intervention";
  return ids.every((id) => rows.some((row) => row.stripePaymentIntentId === id && row.status === "refunded")) ? "settled" : "pending";
}


export async function markTopUpResolutionAndAttemptIntervention({ topUpAttemptId, recoveryLeaseToken, lastError, prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
    if (!resolution || resolution.status !== "refund_pending") return false;
    const attempt = await tx.topUpCheckoutAttempt.updateMany({ where: { id: topUpAttemptId, recoveryLeaseToken, stripeCheckoutSessionId: null }, data: { recoveryInterventionAt: new Date(), recoveryLastError: lastError, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
    if (attempt.count !== 1) throw new Error("Top-up intervention attempt CAS lost");
    const updated = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, revision: resolution.revision, status: "refund_pending" }, data: { status: "intervention", lastError, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Top-up intervention resolution CAS lost");
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function scheduleTopUpCheckoutResolution({ topUpAttemptId, recoveryLeaseToken, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, expectedPaymentIntents, now = new Date(), prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; ownerUserId: string; stripeCustomerId: string; billingOfferId: string; canonicalSessionId: string | null; expectedPaymentIntents: Array<{ paymentIntentId: string; amount: number; currency: string }>; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findFirst({ where: { id: topUpAttemptId, recoveryLeaseToken, stripeCheckoutSessionId: null }, select: { id: true } });
    if (!attempt) throw new Error("Top-up resolution recovery lease lost");
    const current = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
    const oldIds = current ? JSON.parse(current.expectedPaymentIntentIds) as string[] : [];
    const union = [...new Set([...oldIds, ...expectedPaymentIntents.map((item) => item.paymentIntentId)])];
    const row = await recordTopUpCheckoutResolution({ topUpAttemptId, ownerUserId, stripeCustomerId, billingOfferId, canonicalSessionId, expectedPaymentIntentIds: union, expectedRevision: current?.revision, status: "refund_pending", prisma: tx });
    for (const payment of expectedPaymentIntents.filter((item) => !oldIds.includes(item.paymentIntentId))) await scheduleTopUpDuplicateRefundAttempt({ topUpAttemptId, stripePaymentIntentId: payment.paymentIntentId, stripeCustomerId, ownerUserId, billingOfferId, amount: payment.amount, currency: payment.currency, prisma: tx });
    return row;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function getTopUpCheckoutResolution({ topUpAttemptId, prisma }: { topUpAttemptId: string; prisma?: PrismaTransaction }) { return await (prisma ?? await getDb()).topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } }); }

export type TopUpCheckoutFinalization =
  | { outcome: "bind"; sessionId: string; expiresAt: Date }
  | { outcome: "terminal" };

export async function finalizeTopUpCheckoutResolutionAtomically({ topUpAttemptId, recoveryLeaseToken, finalization, prisma }: { topUpAttemptId: string; recoveryLeaseToken: string; finalization: TopUpCheckoutFinalization; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const resolution = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId } });
    if (!resolution || resolution.status !== "refund_pending") return false;
    const expectedIds = JSON.parse(resolution.expectedPaymentIntentIds ?? "[]") as string[];
    if (expectedIds.length > 0) {
      const rows = await tx.topUpDuplicateRefundAttempt.findMany({ where: { stripePaymentIntentId: { in: expectedIds } }, select: { stripePaymentIntentId: true, status: true } });
      if (!expectedIds.every((id) => rows.some((row) => row.stripePaymentIntentId === id && row.status === "refunded"))) throw new Error("Top-up checkout resolution refunds are not settled");
    }
    const updatedAttempt = await tx.topUpCheckoutAttempt.updateMany({ where: { id: topUpAttemptId, recoveryLeaseToken, stripeCheckoutSessionId: null }, data: finalization.outcome === "bind" ? { stripeCheckoutSessionId: finalization.sessionId, expiresAt: finalization.expiresAt, status: "refund_required", refundNotBefore: new Date(), recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } : { status: "refund_not_required", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
    if (updatedAttempt.count !== 1) throw new Error("Top-up resolution attempt CAS lost");
    const updatedResolution = await tx.topUpCheckoutResolution.updateMany({ where: { id: resolution.id, topUpAttemptId, revision: resolution.revision, status: "refund_pending" }, data: { status: finalization.outcome === "bind" ? "resolved" : "terminal", revision: { increment: 1 } } });
    if (updatedResolution.count !== 1) throw new Error("Top-up resolution CAS lost");
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}
