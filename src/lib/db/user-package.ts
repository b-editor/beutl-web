import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

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
  return await db.userPackage.create({
    data: { userId, packageId },
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
