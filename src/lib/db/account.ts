import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function retrieveAccounts({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || sharedPrisma).account.findMany({
    where: {
      userId: userId,
    },
    select: {
      providerAccountId: true,
      provider: true,
    },
  });
}

export async function retrieveAccountsWithIdToken({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || sharedPrisma).account.findMany({
    where: {
      userId: userId,
    },
    select: {
      providerAccountId: true,
      provider: true,
      id_token: true,
    },
  });
}

export async function deleteAccount({
  providerAccountId,
  provider,
  prisma,
}: {
  providerAccountId: string;
  provider: string;
  prisma?: PrismaTransaction;
}) {
  await (prisma || sharedPrisma).account.delete({
    where: {
      provider_providerAccountId: {
        providerAccountId,
        provider,
      },
    },
    select: {},
  });
}
