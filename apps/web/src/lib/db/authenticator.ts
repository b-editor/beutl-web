import "server-only";
import { getDbAsync } from "@/prisma";
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
  const db = prisma || await getDbAsync();
  await db.authenticator.update({
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
  const db = prisma || await getDbAsync();
  await db.authenticator.delete({
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
  const db = prisma || await getDbAsync();
  await db.authenticator.update({
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
  const db = prisma || await getDbAsync();
  return await db.authenticator.findFirst({
    where: {
      providerAccountId,
    },
  });
}
