import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function createStorageUpload({
  userId,
  id,
  objectKey,
  uploadId,
  name,
  mimeType,
  size,
  partSize,
  prisma,
}: {
  userId: string;
  id: string;
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
    data: { id, userId, objectKey, uploadId, name, mimeType, size, partSize },
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

// 完了したアップロードの控えを残す。行ごと消すと、完了応答だけが失われたときに
// 同じ id で結果を取り直せず、やり直しが二重ファイルになる。
//
// 掃除に取られた行には書けない。取られたということは、そのオブジェクトはもう
// 捨てられる——控えを書いてしまうと、File が消えたオブジェクトを指す。書けたか
// どうかを返すので、呼び出し側はその場合に自分が組み上げたオブジェクトを片付け
// られる。
export async function markStorageUploadCompleted({
  id,
  fileId,
  prisma,
}: {
  id: string;
  fileId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: { id, abandonedAt: null },
    data: { completedFileId: fileId },
  });
  return result.count > 0;
}

// 「この行のパートは自分が捨てる」と宣言する。完了済みでも、既に誰かが宣言して
// いても取れない。取れた行にはもう控えを書けないので、そのあとで中止しても
// オブジェクトを消しても、File がそれを指すことはない。
export async function claimStorageUploadForAbandon({
  id,
  now,
  prisma,
}: {
  id: string;
  now: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: { id, completedFileId: null, abandonedAt: null },
    data: { abandonedAt: now },
  });
  return result.count > 0;
}

// まだ終わっていないアップロードの本数。完了済みの控えは数えない——パートは
// もう無く、抱えているものが無いので。
export async function countStorageUploadsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.count({
    where: { userId, completedFileId: null, abandonedAt: null },
  });
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
    // 完了済みの控えの分は File 側に移っているので、ここで数えると二重になる。
    // 掃除に取られた行も同じ——パートはもう誰のものでもない。
    where: { userId, completedFileId: null, abandonedAt: null },
    _sum: { size: true },
  });
  return result._sum.size ?? BigInt(0);
}
