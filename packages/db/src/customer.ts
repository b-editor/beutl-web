import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export const LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT =
  "pre-owner-metadata-2026-08-09";

const ownershipSelect = {
  stripeId: true,
  userId: true,
  migrationCohort: true,
  verifiedAt: true,
  createdAt: true,
} as const;

export async function findCustomerByStripeId({
  stripeId,
  prisma,
}: {
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const read = async (tx: PrismaTransaction) => {
    const customer = await tx.customer.findUnique({
      where: { stripeId },
      select: { userId: true, stripeId: true },
    });
    if (!customer) return null;
    const ownership = await tx.stripeCustomerOwnership.findUnique({
      where: { stripeId: customer.stripeId },
      select: ownershipSelect,
    });
    return { ...customer, ownership };
  };
  return prisma ? await read(prisma) : await startRetryableTransaction(read);
}

export async function findCustomerOwnersByStripeId({
  stripeId,
  prisma,
}: {
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.customer.findMany({
    where: { stripeId },
    select: { userId: true },
    orderBy: { userId: "asc" },
    take: 2,
  });
}

export async function findCustomerByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const read = async (tx: PrismaTransaction) => {
    const customer = await tx.customer.findUnique({ where: { userId } });
    if (!customer) return null;
    const ownership = await tx.stripeCustomerOwnership.findUnique({
      where: { stripeId: customer.stripeId },
      select: ownershipSelect,
    });
    return { ...customer, ownership };
  };
  return prisma ? await read(prisma) : await startRetryableTransaction(read);
}

export async function findStripeCustomerOwnershipByStripeId({
  stripeId,
  prisma,
}: {
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerOwnership.findUnique({
    where: { stripeId },
    select: ownershipSelect,
  });
}

export async function deleteCustomerByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.customer.deleteMany({
    where: {
      userId: userId,
    },
  });
}

async function ensureVerifiedStripeCustomerOwnership({
  userId,
  stripeId,
  verifiedAt,
  prisma,
}: {
  userId: string;
  stripeId: string;
  verifiedAt: Date;
  prisma: PrismaTransaction;
}) {
  const existing = await prisma.stripeCustomerOwnership.findUnique({
    where: { stripeId },
    select: ownershipSelect,
  });
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error("Stripe customer ownership conflicts with another user");
    }
    if (existing.verifiedAt === null) {
      return await prisma.stripeCustomerOwnership.update({
        where: { stripeId },
        data: { verifiedAt },
      });
    }
    return existing;
  }

  return await prisma.stripeCustomerOwnership.create({
    data: {
      userId,
      stripeId,
      verifiedAt,
    },
  });
}

export async function createVerifiedCustomerMappingIfAbsent({
  userId,
  stripeId,
  verifiedAt = new Date(),
  prisma,
}: {
  userId: string;
  stripeId: string;
  verifiedAt?: Date;
  prisma?: PrismaTransaction;
}) {
  const createMapping = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }
    const existing = await tx.customer.findUnique({ where: { userId } });
    if (existing) {
      return existing;
    }
    await ensureVerifiedStripeCustomerOwnership({
      userId,
      stripeId,
      verifiedAt,
      prisma: tx,
    });
    return await tx.customer.create({
      data: { userId, stripeId },
    });
  };
  return prisma
    ? await createMapping(prisma)
    : await startRetryableTransaction(createMapping);
}

export async function replaceCustomerMappingWithVerifiedOwnership({
  userId,
  expectedStripeId,
  stripeId,
  verifiedAt = new Date(),
  prisma,
}: {
  userId: string;
  expectedStripeId: string;
  stripeId: string;
  verifiedAt?: Date;
  prisma?: PrismaTransaction;
}) {
  const replaceMapping = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }
    const current = await tx.customer.findUnique({
      where: { userId },
      select: { stripeId: true },
    });
    if (current?.stripeId !== expectedStripeId && current?.stripeId !== stripeId) {
      return { count: 0 };
    }
    await ensureVerifiedStripeCustomerOwnership({
      userId,
      stripeId,
      verifiedAt,
      prisma: tx,
    });
    if (!current) {
      return { count: 0 };
    }
    if (current.stripeId === stripeId) {
      return { count: 1 };
    }
    return await tx.customer.updateMany({
      where: {
        userId,
        stripeId: expectedStripeId,
      },
      data: { stripeId },
    });
  };
  return prisma
    ? await replaceMapping(prisma)
    : await startRetryableTransaction(replaceMapping);
}

export async function markStripeCustomerOwnershipVerified({
  userId,
  stripeId,
  verifiedAt = new Date(),
  prisma,
}: {
  userId: string;
  stripeId: string;
  verifiedAt?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerOwnership.updateMany({
    where: {
      userId,
      stripeId,
      verifiedAt: null,
    },
    data: { verifiedAt },
  });
}

export async function upsertCustomerMapping({
  userId,
  stripeId,
  verifiedAt = new Date(),
  prisma,
}: {
  userId: string;
  stripeId: string;
  verifiedAt?: Date;
  prisma?: PrismaTransaction;
}) {
  const upsert = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }
    await ensureVerifiedStripeCustomerOwnership({
      userId,
      stripeId,
      verifiedAt,
      prisma: tx,
    });
    return await tx.customer.upsert({
      where: { userId },
      create: { userId, stripeId },
      update: { stripeId },
    });
  };
  return prisma ? await upsert(prisma) : await startRetryableTransaction(upsert);
}
