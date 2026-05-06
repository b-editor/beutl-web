import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function updatePasskeyUsedAt({
  credentialID,
  usedAt,
  prisma,
}: {
  credentialID: string;
  usedAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  await db.passkey.update({
    where: {
      credentialID,
    },
    data: {
      usedAt: usedAt,
    },
  });
}

export async function deletePasskey({
  credentialID,
  userId,
  prisma,
}: {
  credentialID: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  await db.passkey.delete({
    where: {
      credentialID,
      userId,
    },
  });
}

export async function updatePasskeyName({
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
  await db.passkey.update({
    where: {
      credentialID,
      userId,
    },
    data: {
      name,
    },
  });
}

export async function getPasskeysByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return await db.passkey.findMany({
    where: {
      userId,
    },
    select: {
      id: true,
      credentialID: true,
      name: true,
      deviceType: true,
      backedUp: true,
      createdAt: true,
      usedAt: true,
    },
  });
}

export async function findPasskeyByCredentialId({
  credentialID,
  prisma,
}: {
  credentialID: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return await db.passkey.findUnique({
    where: {
      credentialID,
    },
  });
}
