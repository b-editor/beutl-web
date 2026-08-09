import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function findCustomerByStripeId({
  stripeId,
  prisma,
}: {
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.customer.findFirst({
    where: {
      stripeId,
    },
    select: {
      userId: true,
    },
  });
}

export async function findCustomerOwnersByStripeId({
  stripeId,
  prisma,
}: {
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
  return await db.customer.findFirst({
    where: {
      userId: userId,
    },
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

export async function createCustomer({
  userId,
  stripeId,
  prisma,
}: {
  userId: string;
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.customer.create({
    data: {
      userId: userId,
      stripeId: stripeId,
    },
  });
}

export async function upsertCustomerMapping({
  userId,
  stripeId,
  prisma,
}: {
  userId: string;
  stripeId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.customer.upsert({
    where: { userId },
    create: { userId, stripeId },
    update: { stripeId },
  });
}
