import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

export async function beginStripeCustomerProvisioning({
  userId,
  operationKey,
  stripeIdempotencyKey,
  paramsJson,
  leaseToken,
  leaseExpiresAt,
  now = new Date(),
  prisma,
}: {
  userId: string;
  operationKey: string;
  stripeIdempotencyKey?: string;
  paramsJson: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) =>
    {
      const deletionIntent = await tx.accountDeletionIntent.findFirst({
        where: { userId, expiresAt: { gt: now } },
        select: { userId: true },
      });
      if (deletionIntent) throw new Error("Account deletion is already authorized");
      const existing = await tx.stripeCustomerProvisioning.findUnique({ where: { operationKey } });
      if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now) {
        throw new Error("Stripe customer provisioning is leased by another worker");
      }
      return await tx.stripeCustomerProvisioning.upsert({
      where: { operationKey },
      create: { userId, operationKey, stripeIdempotencyKey: stripeIdempotencyKey ?? operationKey, paramsJson, status: "pending", notBefore: now, leaseToken: leaseToken ?? null, leaseExpiresAt: leaseExpiresAt ?? null },
      update: { paramsJson, stripeIdempotencyKey: stripeIdempotencyKey ?? operationKey, notBefore: now, ...(leaseToken ? { leaseToken, leaseExpiresAt } : {}) },
      });
    };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function updateStripeCustomerProvisioningKey({ id, stripeIdempotencyKey, leaseToken, prisma }: { id: string; stripeIdempotencyKey: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const provisioning = await tx.stripeCustomerProvisioning.findUnique({ where: { id }, select: { userId: true, leaseToken: true } });
    if (!provisioning || provisioning.leaseToken !== leaseToken) return { count: 0 };
    const deletionIntent = await tx.accountDeletionIntent.findFirst({ where: { userId: provisioning.userId, expiresAt: { gt: new Date() } }, select: { userId: true } });
    if (deletionIntent) throw new Error("Account deletion is already authorized");
    return await tx.stripeCustomerProvisioning.updateMany({ where: { id, leaseToken }, data: { stripeIdempotencyKey } });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function rotateStripeCustomerProvisioningKey({ id, leaseToken, stripeIdempotencyKey, prisma }: { id: string; leaseToken: string; stripeIdempotencyKey: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({ where: { id, leaseToken, status: { in: ["pending", "mapping"] } }, data: { stripeIdempotencyKey, stripeCustomerId: null, status: "pending", lastError: null } });
}

export async function claimStripeCustomerProvisioning({ id, now, leaseToken, leaseExpiresAt, prisma }: { id: string; now: Date; leaseToken: string; leaseExpiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const updated = await db.stripeCustomerProvisioning.updateMany({
    where: { id, status: { in: ["pending", "mapping", "cleanup_required"] }, notBefore: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    data: { leaseToken, leaseExpiresAt, attempts: { increment: 1 } },
  });
  if (updated.count !== 1) return null;
  return await db.stripeCustomerProvisioning.findUnique({ where: { id } });
}

export async function recordStripeCustomerProvisioningRemote({
  id,
  stripeCustomerId,
  leaseToken,
  prisma,
}: { id: string; stripeCustomerId: string; leaseToken?: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({
    where: { id, ...(leaseToken ? { leaseToken } : { leaseExpiresAt: null }) },
    data: { stripeCustomerId, status: "mapping", lastError: null },
  });
}

export async function settleStripeCustomerProvisioning({
  id,
  leaseToken,
  prisma,
}: { id: string; leaseToken?: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({
    where: { id, ...(leaseToken ? { leaseToken } : { leaseExpiresAt: null }) },
    data: { status: "settled", notBefore: new Date(), leaseToken: null, leaseExpiresAt: null },
  });
}

export async function scheduleStripeCustomerProvisioningCleanup({
  id,
  lastError,
  leaseToken,
  now = new Date(),
  prisma,
}: { id: string; lastError: string; leaseToken?: string; now?: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({
    where: { id, ...(leaseToken ? { leaseToken } : { leaseExpiresAt: null }) },
    data: { status: "cleanup_required", notBefore: now, lastError, leaseToken: null, leaseExpiresAt: null },
  });
}

export async function listDueStripeCustomerProvisioningCleanups({
  now,
  limit = 50,
  prisma,
}: { now: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.findMany({
    where: { status: { in: ["pending", "mapping", "cleanup_required"] }, notBefore: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function markStripeCustomerProvisioningCleaned({
  id,
  leaseToken,
  prisma,
}: { id: string; leaseToken?: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({
    where: { id, ...(leaseToken ? { leaseToken } : { leaseExpiresAt: null }) },
    data: { status: "cleaned", stripeCustomerId: null, notBefore: new Date() },
  });
}

export async function deleteStripeCustomerProvisioning({ id, prisma }: { id: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.deleteMany({ where: { id, status: { in: ["settled", "cleaned"] } } });
}

export async function markStripeCustomerProvisioningIntervention({ id, leaseToken, lastError, prisma }: { id: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.updateMany({ where: { id, leaseToken, status: { in: ["pending", "mapping", "cleanup_required"] } }, data: { status: "intervention", lastError, leaseToken: null, leaseExpiresAt: null } });
}
