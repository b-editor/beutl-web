import { getDb } from "./provider";
import { startTransaction, type PrismaTransaction } from "./transaction";

export async function findUserPackageIdsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.userPackage.findMany({
    where: {
      userId: userId,
    },
    select: {
      packageId: true,
    },
  });
}

export async function deleteUserPackagesByUserAndPackageName({
  userId,
  name,
  prisma,
}: {
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.userPackage.deleteMany({
    where: {
      userId: userId,
      package: {
        name: name,
      },
    },
  });
}

export async function existsUserPackage(
  {
    userId,
    packageId,
  }: {
    userId: string;
    packageId: string;
  },
  prisma?: PrismaTransaction,
) {
  const db = prisma || await getDb();
  return await db.userPackage.findFirst({
    where: { userId, packageId },
  });
}

export async function createUserPackage(
  {
    userId,
    packageId,
    requireActivePayment = false,
  }: {
    userId: string;
    packageId: string;
    requireActivePayment?: boolean;
  },
  prisma?: PrismaTransaction,
) {
  const create = async (tx: PrismaTransaction) => {
    const paymentManaged = Boolean(
      await tx.userPaymentHistory.findFirst({
        where: {
          userId,
          packageId,
          fulfillmentValidated: true,
          revokedAt: null,
        },
        select: { paymentId: true },
      }),
    );
    if (requireActivePayment && !paymentManaged) {
      return null;
    }
    return await tx.userPackage.upsert({
      where: { userId_packageId: { userId, packageId } },
      create: { userId, packageId, paymentManaged },
      update: paymentManaged ? { paymentManaged: true } : {},
    });
  };
  return prisma ? await create(prisma) : await startTransaction(create);
}

export async function deleteUserPackage(
  {
    userId,
    packageId,
  }: {
    userId: string;
    packageId: string;
  },
  prisma?: PrismaTransaction,
) {
  const db = prisma || await getDb();
  return await db.userPackage.delete({
    where: {
      userId_packageId: {
        userId,
        packageId,
      },
    },
    select: {
      package: {
        select: {
          name: true,
        },
      },
    },
  });
}

export async function retrieveLibraryPackagesByUserId({
  userId,
  currency,
  prisma,
}: {
  userId: string;
  currency: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.userPackage.findMany({
    where: {
      userId: userId,
      package: {
        published: true,
      },
    },
    select: {
      package: {
        select: {
          id: true,
          displayName: true,
          name: true,
          shortDescription: true,
          tags: true,
          iconFile: {
            select: {
              id: true,
            },
          },
          user: {
            select: {
              Profile: {
                select: {
                  userName: true,
                },
              },
            },
          },
          packagePricing: {
            where: currency ? {
              OR: [
                {
                  currency: {
                    equals: currency,
                    mode: "insensitive",
                  },
                },
                {
                  fallback: true,
                },
              ],
            } : {
              fallback: true,
            },
            select: {
              price: true,
              currency: true,
              fallback: true,
            },
          },
        },
      },
    },
  });
}

