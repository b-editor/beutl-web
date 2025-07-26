import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";
import { headers } from "next/headers";

export async function getContentUrl(id?: string | null) {
  if (!id) return null;
  const url = (await headers()).get("x-url") as string;
  const origin = new URL(url).origin;
  return `${origin}/api/contents/${id}`;
}

export async function retrieveFilesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return await db.file.findMany({
    where: {
      userId: userId,
    },
  });
}

export async function createFile({
  userId,
  name,
  objectKey,
  size,
  mimeType,
  visibility,
  prisma,
  sha256,
}: {
  userId: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  prisma?: PrismaTransaction;
  sha256?: string;
}) {
  const db = prisma || await getDbAsync();
  return await db.file.create({
    data: {
      objectKey,
      name,
      size,
      mimeType,
      userId,
      visibility,
      sha256,
    },
  });
}

export async function deleteFile({
  fileId,
  prisma,
}: {
  fileId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return await db.file.delete({
    where: {
      id: fileId,
    },
  });
}
