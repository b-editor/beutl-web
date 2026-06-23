import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function updateNativeAppAuthCode({
  id: identifier,
  userId,
  codeExpires,
  code,
  prisma,
}: {
  id: string;
  userId: string;
  codeExpires: Date;
  code: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.update({
    where: {
      id: identifier,
    },
    data: {
      userId,
      codeExpires,
      code,
    },
  });
}

export async function createNativeAppAuth({
  continueUrl,
  prisma,
}: {
  continueUrl: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.create({
    data: {
      continueUrl,
    },
  });
}

export async function findNativeAppAuthById({
  id: identifier,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.findFirst({
    where: {
      id: identifier,
    },
  });
}

export async function updateNativeAppAuthForHandler({
  id: identifier,
  userId,
  code,
  codeExpires,
  prisma,
}: {
  id: string;
  userId: string;
  code: string;
  codeExpires: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.update({
    where: {
      id: identifier,
    },
    data: {
      userId,
      code,
      codeExpires,
    },
    select: {
      code: true,
      continueUrl: true,
    },
  });
}

export async function findNativeAppAuthBySessionId({
  sessionId,
  prisma,
}: {
  sessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.findFirst({
    where: {
      sessionId,
    },
  });
}

export async function deleteNativeAppAuthBySessionId({
  sessionId,
  prisma,
}: {
  sessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.deleteMany({
    where: {
      sessionId,
    },
  });
}
