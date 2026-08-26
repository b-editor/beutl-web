import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { schedulePackagePaymentRefundAttempt } from "./package-payment-refund-attempt";

type PackageCheckoutResolutionStatus = "intervention" | "refund_pending" | "resolved" | "terminal";

async function recordPackageCheckoutResolution({ attemptId, discoveryToken, operatorUserId, expectedRevision, canonicalSessionId, canonicalPaymentIntentId, expectedRefundPaymentIntentIds = [], status = "intervention", evidenceJson, lastError, prisma }: { attemptId: string; discoveryToken: string; operatorUserId?: string | null; expectedRevision?: number; canonicalSessionId?: string | null; canonicalPaymentIntentId?: string | null; expectedRefundPaymentIntentIds?: string[]; status?: PackageCheckoutResolutionStatus; evidenceJson: string; lastError?: string; prisma?: PrismaTransaction }) {
  JSON.parse(evidenceJson);
  const db = prisma ?? await getDb();
  const expected = JSON.stringify([...new Set(expectedRefundPaymentIntentIds)].sort());
  const table = db.packageCheckoutResolution;
  const existing = await table.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
  if (existing) {
    if (existing.status === "refund_pending" && status === "intervention") return existing;
    // A resolver may have reached a provisional `resolved` state before a
    // final Stripe refresh exposed another unrefunded duplicate. Reopen that
    // row only through the lease-guarded refund scheduler; terminal rows can
    // never be reopened.
    const reopeningResolved = existing.status === "resolved" && (status === "intervention" || status === "refund_pending");
    if (["resolved", "terminal"].includes(existing.status) && status !== existing.status && !reopeningResolved) throw new Error("Package checkout resolution status regression");
    if (existing.canonicalSessionId && canonicalSessionId && existing.canonicalSessionId !== canonicalSessionId) throw new Error("Package checkout resolution canonical Session conflict");
    if (existing.canonicalPaymentIntentId && canonicalPaymentIntentId && existing.canonicalPaymentIntentId !== canonicalPaymentIntentId) throw new Error("Package checkout resolution canonical PaymentIntent conflict");
    const oldIds = JSON.parse(existing.expectedRefundPaymentIntentIds) as string[];
    if (!oldIds.every((id) => expected === "[]" || JSON.parse(expected).includes(id))) throw new Error("Package checkout resolution refund identity conflict");
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) throw new Error("Package checkout resolution revision conflict");
    const updated = await table.updateMany({ where: { id: existing.id, revision: existing.revision }, data: { status, operatorUserId: operatorUserId ?? undefined, canonicalSessionId: existing.canonicalSessionId ?? canonicalSessionId ?? null, canonicalPaymentIntentId: existing.canonicalPaymentIntentId ?? canonicalPaymentIntentId ?? null, expectedRefundPaymentIntentIds: expected === "[]" ? existing.expectedRefundPaymentIntentIds : expected, evidenceJson, lastError: lastError ?? existing.lastError, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Package checkout resolution revision CAS lost");
    return await table.findUnique({ where: { id: existing.id } });
  }
  try {
    return await table.create({ data: { attemptId, discoveryToken, operatorUserId: operatorUserId ?? null, canonicalSessionId: canonicalSessionId ?? null, canonicalPaymentIntentId: canonicalPaymentIntentId ?? null, expectedRefundPaymentIntentIds: expected, status, evidenceJson, lastError: lastError ?? null } });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const raced = await table.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
    if (!raced) throw error;
    return await recordPackageCheckoutResolution({ attemptId, discoveryToken, operatorUserId, expectedRevision: raced.revision, canonicalSessionId, canonicalPaymentIntentId, expectedRefundPaymentIntentIds, status, evidenceJson, lastError, prisma });
  }
}

export async function recordPackageCheckoutIntervention({ attemptId, discoveryToken, evidenceJson, operatorUserId, lastError, prisma }: { attemptId: string; discoveryToken: string; evidenceJson: string; operatorUserId?: string | null; lastError?: string; prisma?: PrismaTransaction }) {
  return await recordPackageCheckoutResolution({ attemptId, discoveryToken, operatorUserId, evidenceJson, lastError, status: "intervention", prisma });
}

export async function schedulePackageCheckoutResolutionRefunds({ attemptId, discoveryToken, recoveryLeaseToken, operatorUserId, expectedRevision, canonicalSessionId, canonicalPaymentIntentId, refunds, evidenceJson, now = new Date(), prisma }: { attemptId: string; discoveryToken: string; recoveryLeaseToken: string; operatorUserId?: string | null; expectedRevision?: number; canonicalSessionId: string | null; canonicalPaymentIntentId: string | null; refunds: Array<{ paymentIntentId: string; amount: number; currency: string; customerId: string; userId: string; packageId: string }>; evidenceJson: string; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.packageCheckoutAttempt.findFirst({ where: { id: attemptId, discoveryToken, status: "intervention", stripeCheckoutSessionId: null, recoveryLeaseToken }, select: { id: true } });
    if (!attempt) throw new Error("Package checkout resolution recovery lease lost");
    const expected = refunds.map((refund) => refund.paymentIntentId);
    const current = await tx.packageCheckoutResolution.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
    if (expectedRevision !== undefined && current && current.revision !== expectedRevision) throw new Error("Package checkout resolution revision conflict");
    const existingExpected = current ? JSON.parse(current.expectedRefundPaymentIntentIds) as string[] : [];
    const union = [...new Set([...existingExpected, ...expected])];
    if (current && !existingExpected.every((id) => union.includes(id))) throw new Error("Package checkout resolution refund set regression");
    const newIds = new Set(expected.filter((id) => !existingExpected.includes(id)));
    // No refund ids is not terminal: a final Stripe refresh can still reveal
    // a newly completed duplicate. `finalizePackageCheckoutResolution` is the
    // only operation allowed to move this intervention to resolved/terminal.
    const row = await recordPackageCheckoutResolution({ attemptId, discoveryToken, operatorUserId, expectedRevision: current?.revision, canonicalSessionId, canonicalPaymentIntentId, expectedRefundPaymentIntentIds: union, status: union.length > 0 ? "refund_pending" : "intervention", evidenceJson, prisma: tx });
    for (const refund of refunds.filter((item) => newIds.has(item.paymentIntentId))) await schedulePackagePaymentRefundAttempt({ ...refund, reason: `package checkout resolution ${attemptId}`, now, prisma: tx });
    return row;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export type PackageCheckoutFinalization =
  | { outcome: "bind"; sessionId: string; expiresAt: Date }
  | { outcome: "terminal" };

export async function finalizePackageCheckoutResolution({ attemptId, discoveryToken, leaseToken, revision, finalization, prisma }: { attemptId: string; discoveryToken: string; leaseToken: string; revision: number; finalization: PackageCheckoutFinalization; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.packageCheckoutResolution.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
    if (!current || current.revision !== revision || !["refund_pending", "intervention", "resolved"].includes(current.status)) throw new Error("Package checkout finalization resolution CAS lost");
    const expectedIds = JSON.parse(current.expectedRefundPaymentIntentIds) as string[];
    if (expectedIds.length > 0) {
      const refunds = await tx.packagePaymentRefundAttempt.findMany({ where: { paymentIntentId: { in: expectedIds } }, select: { paymentIntentId: true, status: true } });
      if (!expectedIds.every((id) => refunds.some((refund) => refund.paymentIntentId === id && refund.status === "refunded"))) throw new Error("Package checkout resolution refunds are not settled");
    }
    const attempt = await tx.packageCheckoutAttempt.updateMany({ where: { id: attemptId, discoveryToken, status: "intervention", stripeCheckoutSessionId: null, recoveryLeaseToken: leaseToken }, data: finalization.outcome === "bind" ? { status: "open", stripeCheckoutSessionId: finalization.sessionId, expiresAt: finalization.expiresAt, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } : { status: "terminal", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null } });
    if (attempt.count !== 1) throw new Error("Package checkout finalization attempt CAS lost");
    const resolution = await tx.packageCheckoutResolution.updateMany({ where: { attemptId, discoveryToken, revision, status: current.status }, data: { status: finalization.outcome === "bind" ? "resolved" : "terminal", revision: { increment: 1 } } });
    if (resolution.count !== 1) throw new Error("Package checkout finalization resolution CAS lost");
    return { attempt, resolution };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}


export async function getPackageCheckoutResolution({ attemptId, discoveryToken, prisma }: { attemptId: string; discoveryToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutResolution.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
}

export async function packageCheckoutResolutionRefundState({ attemptId, discoveryToken, prisma }: { attemptId: string; discoveryToken: string; prisma?: PrismaTransaction }): Promise<"none" | "pending" | "intervention" | "settled"> {
  const db = prisma ?? await getDb();
  const row = await db.packageCheckoutResolution.findUnique({ where: { attemptId_discoveryToken: { attemptId, discoveryToken } } });
  if (!row) return "none";
  const ids = JSON.parse(row.expectedRefundPaymentIntentIds) as string[];
  if (row.status === "resolved") return "settled";
  if (ids.length === 0) return "none";
  const attempts = await db.packagePaymentRefundAttempt.findMany({ where: { paymentIntentId: { in: ids } }, select: { paymentIntentId: true, status: true } });
  if (attempts.some((attempt) => attempt.status === "intervention")) return "intervention";
  if (ids.every((id) => attempts.some((attempt) => attempt.paymentIntentId === id && attempt.status === "refunded"))) return "settled";
  return "pending";
}

export async function markPackageCheckoutResolutionIntervention({ attemptId, discoveryToken, lastError, prisma }: { attemptId: string; discoveryToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutResolution.updateMany({ where: { attemptId, discoveryToken, status: "refund_pending" }, data: { status: "intervention", lastError } });
}
