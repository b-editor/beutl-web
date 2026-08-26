import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

export async function scheduleStripeCheckoutCleanup({
  sessionId,
  userId,
  kind,
  customerId,
  packageId,
  billingOfferId,
  now = new Date(),
  prisma,
}: {
  sessionId: string;
  userId: string;
  kind: string;
  customerId: string;
  packageId?: string | null;
  billingOfferId?: string | null;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const existing = await tx.stripeCheckoutCleanup.findUnique({ where: { sessionId } });
    if (existing) {
      if (existing.userId !== userId || existing.kind !== kind || existing.customerId !== customerId || existing.packageId !== (packageId ?? null) || existing.billingOfferId !== (billingOfferId ?? null)) {
        throw new Error(`Checkout cleanup ${sessionId} identity conflict`);
      }
      if (existing.status === "completed" || existing.status === "intervention") return existing;
      if (existing.leaseExpiresAt && existing.leaseExpiresAt > now && existing.leaseToken) return existing;
      return await tx.stripeCheckoutCleanup.update({ where: { id: existing.id }, data: { notBefore: existing.notBefore < now ? existing.notBefore : now } });
    }
    return await tx.stripeCheckoutCleanup.create({
      data: {
        sessionId,
        userId,
        kind,
        customerId,
        packageId: packageId ?? null,
        billingOfferId: billingOfferId ?? null,
        status: "required",
        notBefore: now,
      },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function listDueStripeCheckoutCleanups({ now, limit = 50, prisma }: { now: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCheckoutCleanup.findMany({
    where: {
      status: { in: ["required", "retry"] },
      notBefore: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function claimStripeCheckoutCleanup({ id, now, leaseToken, leaseExpiresAt, prisma }: { id: string; now: Date; leaseToken: string; leaseExpiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const updated = await db.stripeCheckoutCleanup.updateMany({
    where: { id, status: { in: ["required", "retry"] }, notBefore: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    data: { status: "retry", leaseToken, leaseExpiresAt, attempts: { increment: 1 } },
  });
  if (updated.count !== 1) return null;
  return await db.stripeCheckoutCleanup.findUnique({ where: { id } });
}

export async function completeStripeCheckoutCleanup({ id, leaseToken, prisma }: { id: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCheckoutCleanup.updateMany({ where: { id, status: "retry", leaseToken }, data: { status: "completed", leaseToken: null, leaseExpiresAt: null } });
}

export async function rescheduleStripeCheckoutCleanup({ id, leaseToken, notBefore, lastError, prisma }: { id: string; leaseToken: string; notBefore: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCheckoutCleanup.updateMany({ where: { id, status: "retry", leaseToken }, data: { status: "required", notBefore, lastError, leaseToken: null, leaseExpiresAt: null } });
}

export async function markStripeCheckoutCleanupIntervention({ id, leaseToken, lastError, prisma }: { id: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCheckoutCleanup.updateMany({
    where: { id, status: "retry", leaseToken },
    data: { status: "intervention", lastError, leaseToken: null, leaseExpiresAt: null },
  });
}
