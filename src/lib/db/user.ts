import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function existsUserByEmail({
  email, prisma
}: {
  email: string, prisma?: PrismaTransaction
}) {
  return !!await (prisma || sharedPrisma).user.findFirst({
    where: {
      email: email
    },
    select: {
      id: true
    }
  });
}

export async function existsUserById({
  id, prisma
}: {
  id: string, prisma?: PrismaTransaction
}) {
  return !!await (prisma || sharedPrisma).user.findFirst({
    where: {
      id: id
    },
    select: {
      id: true
    }
  });
}

export async function updateUserEmail({
  userId, email, prisma
}: {
  userId: string, email: string, prisma?: PrismaTransaction
}) {
  await (prisma || sharedPrisma).user.update({
    where: {
      id: userId
    },
    data: {
      email: email
    },
    select: {}
  });
}

export async function findEmailByUserId({
  userId, prisma
}: {
  userId: string, prisma?: PrismaTransaction
}) {
  return (prisma || sharedPrisma).user.findFirst({
    where: {
      id: userId
    },
    select: {
      email: true
    }
  });
}

export async function getEmailVerifiedByUserId({
  userId, prisma
}: {
  userId: string, prisma?: PrismaTransaction
}) {
  return (await (prisma || sharedPrisma).user.findFirst({
    where: {
      id: userId
    },
    select: {
      emailVerified: true
    }
  }))?.emailVerified;
}

export async function deleteUserById({
  userId, prisma
}: {
  userId: string, prisma?: PrismaTransaction
}) {
  await (prisma || sharedPrisma).user.delete({
    where: {
      id: userId
    },
    select: {}
  });
}