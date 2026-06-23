import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function findUserPackageIdsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
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
  const db = prisma ?? await getDbAsync();
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
  const db = prisma || await getDbAsync();
  return await db.userPackage.findFirst({
    where: { userId, packageId },
  });
}

export async function createUserPackage(
  {
    userId,
    packageId,
  }: {
    userId: string;
    packageId: string;
  },
  prisma?: PrismaTransaction,
) {
  const db = prisma || await getDbAsync();
  return await db.userPackage.upsert({
    where: { userId_packageId: { userId, packageId } },
    create: { userId, packageId },
    update: {},
  });
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
  const db = prisma || await getDbAsync();
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
  const db = prisma || await getDbAsync();
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
