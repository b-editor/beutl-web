import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function scheduleTopUpDuplicateRefundAttempt({ topUpAttemptId, stripePaymentIntentId, stripeCustomerId, ownerUserId, billingOfferId, amount, currency, prisma }: { topUpAttemptId: string; stripePaymentIntentId: string; stripeCustomerId: string; ownerUserId: string; billingOfferId: string; amount: number; currency: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const existing = await db.topUpDuplicateRefundAttempt.findUnique({ where: { stripePaymentIntentId } });
  if (existing) {
    if (existing.topUpAttemptId !== topUpAttemptId || existing.stripeCustomerId !== stripeCustomerId || existing.ownerUserId !== ownerUserId || existing.billingOfferId !== billingOfferId || existing.amount !== amount || existing.currency.toLowerCase() !== currency.toLowerCase()) throw new Error("Top-up duplicate refund identity conflict");
    return existing;
  }
  return await db.topUpDuplicateRefundAttempt.create({ data: { topUpAttemptId, stripePaymentIntentId, stripeCustomerId, ownerUserId, billingOfferId, amount, currency, status: "required" } });
}

export async function claimTopUpDuplicateRefundAttempts({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.topUpDuplicateRefundAttempt.findMany({ where: { status: { in: ["required", "retry"] }, notBefore: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.topUpDuplicateRefundAttempt.updateMany({ where: { id: row.id, status: row.status, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }, data: { status: "processing", leaseToken, leaseExpiresAt, attempts: { increment: 1 } } });
    if (updated.count === 1) claimed.push({ ...row, status: "processing", leaseToken });
  }
  return claimed;
}

export async function completeTopUpDuplicateRefundAttempt({ id, leaseToken, refundId, refundedAmount, prisma }: { id: string; leaseToken: string; refundId: string; refundedAmount: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpDuplicateRefundAttempt.updateMany({ where: { id, status: "processing", leaseToken }, data: { status: "refunded", refundId, refundedAmount, leaseToken: null, leaseExpiresAt: null } });
}

export async function rescheduleTopUpDuplicateRefundAttempt({ id, leaseToken, notBefore, lastError, prisma }: { id: string; leaseToken: string; notBefore: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpDuplicateRefundAttempt.updateMany({ where: { id, status: "processing", leaseToken }, data: { status: "retry", notBefore, lastError, leaseToken: null, leaseExpiresAt: null } });
}

export async function markTopUpDuplicateRefundIntervention({ id, leaseToken, lastError, prisma }: { id: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpDuplicateRefundAttempt.updateMany({ where: { id, status: "processing", leaseToken }, data: { status: "intervention", lastError, leaseToken: null, leaseExpiresAt: null } });
}
