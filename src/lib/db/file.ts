import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function retrieveFilesByUserId({
  userId, prisma
}: {
  userId: string,
  prisma?: PrismaTransaction
}) {
  return await (prisma || sharedPrisma).file.findMany({
    where: {
      userId: userId
    }
  });
}

export async function createFile({
  userId, name, objectKey, size, mimeType, visibility, prisma, sha256
}: {
  userId: string,
  name: string,
  objectKey: string,
  size: number,
  mimeType: string,
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED",
  prisma?: PrismaTransaction,
  sha256?: string
}) {
  return await (prisma || sharedPrisma).file.create({
    data: {
      objectKey,
      name,
      size,
      mimeType,
      userId,
      visibility,
      sha256
    },
  });
}

export async function deleteFile({
  fileId, prisma
}: {
  fileId: string,
  prisma?: PrismaTransaction
}) {
  return await (prisma || sharedPrisma).file.delete({
    where: {
      id: fileId
    }
  });
}