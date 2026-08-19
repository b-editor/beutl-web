import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function createStorageUpload({
  userId,
  objectKey,
  uploadId,
  name,
  mimeType,
  size,
  partSize,
  prisma,
}: {
  userId: string;
  objectKey: string;
  uploadId: string;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.create({
    data: { userId, objectKey, uploadId, name, mimeType, size, partSize },
  });
}

// An upload is only ever reached through its own id together with the user it
// belongs to: the bucket would take parts from anyone who knew the key and the
// upload id, so those are never what a request is trusted on.
export async function findStorageUploadByIdAndUserId({
  id,
  userId,
  prisma,
}: {
  id: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.findFirst({ where: { id, userId } });
}

export async function deleteStorageUpload({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.storageUpload.deleteMany({ where: { id } });
}

// What a browser started and never finished. An unfinished upload holds its
// parts, and their storage, until it is abandoned.
export async function listStorageUploadsStartedBefore({
  before,
  limit,
  prisma,
}: {
  before: Date;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.findMany({
    where: { createdAt: { lt: before } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

// How much of the quota the uploads in progress have already spoken for. Two
// uploads started at once would each see only what is already stored, and
// together they could pass the quota; counting what is under way stops that.
export async function sumStorageUploadSizeByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.aggregate({
    where: { userId },
    _sum: { size: true },
  });
  return result._sum.size ?? BigInt(0);
}
