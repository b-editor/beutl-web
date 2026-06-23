import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function findFileForApi({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.file.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
      name: true,
      mimeType: true,
      userId: true,
      size: true,
      sha256: true,
    },
  });
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

export async function retrieveFilesByIdsAndUserId({
  ids,
  userId,
  prisma,
}: {
  ids: string[];
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.file.findMany({
    where: {
      id: {
        in: ids,
      },
      userId,
    },
    select: {
      objectKey: true,
      id: true,
      visibility: true,
    },
  });
}

export async function updateFileVisibility({
  fileId,
  visibility,
  prisma,
}: {
  fileId: string;
  visibility: "PRIVATE" | "PUBLIC";
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.file.update({
    where: {
      id: fileId,
    },
    data: {
      visibility: visibility,
    },
  });
}

export async function retrieveFileNamesAndSizesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.file.findMany({
    where: {
      userId,
    },
    select: {
      size: true,
      name: true,
    },
  });
}

export async function retrieveStorageFilesByUserId({
  userId,
  prisma,
}: {
  userId?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.file.findMany({
    where: {
      userId,
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
    },
  });
}
