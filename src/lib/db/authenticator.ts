import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function updateAuthenticatorUsedAt({
  credentialID,
  usedAt,
  prisma,
}: {
  credentialID: string;
  usedAt: Date;
  prisma?: PrismaTransaction;
}) {
  await (prisma || await sharedPrisma()).authenticator.update({
    where: {
      credentialID,
    },
    data: {
      usedAt: usedAt,
    },
  });
}

export async function deleteAuthenticator({
  credentialID,
  userId,
  prisma,
}: {
  credentialID: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  await (prisma || await sharedPrisma()).authenticator.delete({
    where: {
      userId_credentialID: {
        userId,
        credentialID,
      },
    },
  });
}

export async function updateAuthenticatorName({
  credentialID,
  userId,
  name,
  prisma,
}: {
  credentialID: string;
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}) {
  await (prisma || await sharedPrisma()).authenticator.update({
    where: {
      userId_credentialID: {
        userId,
        credentialID,
      },
    },
    data: {
      name,
    },
  });
}

export async function findAuthenticatorByAccountId({
  providerAccountId,
  prisma,
}: {
  providerAccountId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || await sharedPrisma()).authenticator.findFirst({
    where: {
      providerAccountId,
    },
  });
}
