import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function existsUserByEmail({
  email,
  prisma,
}: {
  email: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return !!(await db.user.findFirst({
    where: {
      email: email,
    },
    select: {
      id: true,
    },
  }));
}

export async function existsUserById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return !!(await db.user.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
    },
  }));
}

export async function updateUserEmail({
  userId,
  email,
  prisma,
}: {
  userId: string;
  email: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  await db.user.update({
    where: {
      id: userId,
    },
    data: {
      email: email,
    }
  });
}

export async function findEmailByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return db.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      email: true,
    },
  });
}

export async function getEmailVerifiedByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return (
    await db.user.findFirst({
      where: {
        id: userId,
      },
      select: {
        emailVerified: true,
      },
    })
  )?.emailVerified;
}

export async function deleteUserById({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  await db.user.delete({
    where: {
      id: userId,
    }
  });
}
