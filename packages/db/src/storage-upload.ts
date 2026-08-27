import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

async function insertStorageUpload({
  userId,
  id,
  objectKey,
  uploadId,
  name,
  mimeType,
  size,
  partSize,
  abandonedAt,
  startState = "active",
  creationLeaseUntil,
  creationLeaseToken,
  prisma,
}: {
  userId: string;
  id: string;
  objectKey: string;
  uploadId: string | null;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  // 最初から掃除のものとして置く行。誰も知らないまま残ったマルチパートを、
  // 掃除が見つけられる場所に書き留めるために使う。
  abandonedAt?: Date;
  startState?: "intent" | "creating" | "active";
  creationLeaseUntil?: Date | null;
  creationLeaseToken?: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.create({
    data: {
      id,
      userId,
      objectKey,
      uploadId,
      name,
      mimeType,
      size,
      partSize,
      ...(abandonedAt ? { abandonedAt } : {}),
      startState,
      creationLeaseUntil: creationLeaseUntil ?? null,
      creationLeaseToken: creationLeaseToken ?? null,
    },
  });
}

/** Reserve quota and persist a start intent before contacting the bucket. */
export async function createStorageUploadIntent({
  userId,
  id,
  objectKey,
  name,
  mimeType,
  size,
  partSize,
  prisma,
}: {
  userId: string;
  id: string;
  objectKey: string;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  prisma?: PrismaTransaction;
}) {
  return insertStorageUpload({
    userId,
    id,
    objectKey,
    uploadId: null,
    name,
    mimeType,
    size,
    partSize,
    startState: "intent",
    creationLeaseUntil: null,
    prisma,
  });
}

/** Persist a cancellation tombstone for an upload that never reached storage. */
export async function createStorageUploadCancellationTombstone({
  userId, id, now, prisma,
}: { userId: string; id: string; now: Date; prisma?: PrismaTransaction }) {
  return insertStorageUpload({
    userId, id, objectKey: "", uploadId: "", name: "",
    mimeType: "application/octet-stream", size: BigInt(0),
    partSize: 5 * 1024 * 1024, abandonedAt: now, startState: "active", prisma,
  });
}

/** Claim a durable intent for remote creation. Exactly one caller wins. */
export async function claimStorageUploadCreation({
  id,
  userId,
  now,
  leaseUntil,
  leaseToken,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  leaseUntil: Date;
  leaseToken: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      uploadId: null,
      abandonedAt: null,
      OR: [
        { startState: "intent" },
        { startState: "creating", creationLeaseUntil: { lte: now } },
      ],
    },
    data: { startState: "creating", creationLeaseUntil: leaseUntil, creationLeaseToken: leaseToken },
  });
  return result.count > 0;
}

/** Attach the exact remote handle only while this creator's lease is current. */
export async function attachStorageUploadRemote({
  id,
  userId,
  uploadId,
  leaseToken,
  prisma,
}: {
  id: string;
  userId: string;
  uploadId: string;
  leaseToken: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: { id, userId, uploadId: null, startState: "creating", abandonedAt: null, creationLeaseToken: leaseToken },
    data: { uploadId, startState: "active", creationLeaseUntil: null, creationLeaseToken: null },
  });
  return result.count > 0;
}

/** Record a remote handle after the creator's leased attach did not return success. */
export async function recordStorageUploadRemoteAfterAttachFailure({
  id,
  userId,
  uploadId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  uploadId: string;
  expected: StorageUploadGenerationExpectation & {
    uploadId: null;
    startState: "creating";
  };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      uploadId: null,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: "creating",
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: {
      uploadId,
      startState: "active",
      creationLeaseUntil: null,
      creationLeaseToken: null,
    },
  });
  return result.count > 0;
}

/** Return an unknown-outcome create to the retryable intent state. */
export async function releaseStorageUploadCreation({
  id,
  now,
  leaseToken,
  prisma,
}: {
  id: string;
  now: Date;
  leaseToken: string | null;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      uploadId: null,
      startState: "creating",
      creationLeaseUntil: { lte: now },
      creationLeaseToken: leaseToken,
    },
    data: { startState: "intent", creationLeaseUntil: null, creationLeaseToken: null },
  });
  return result.count > 0;
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

/** Delete only the exact row snapshot already frozen for remote cleanup. */
export async function deleteClaimedStorageUpload({
  id,
  userId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  expected: StorageUploadAbandonExpectation & { abandonedAt: Date };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.storageUpload.deleteMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: expected.abandonedAt,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      cleanupLeaseUntil: expected.cleanupLeaseUntil,
      cleanupLeaseToken: expected.cleanupLeaseToken,
    },
  });
  return deleted.count === 1;
}

/**
 * Replace a terminal multipart handle with a delayed object cleanup, then drop
 * only that claimed upload generation. The transaction closes the interval in
 * which an in-flight complete could otherwise publish after all tracking was
 * removed.
 */
export async function settleTerminalClaimedStorageUpload({
  id,
  userId,
  expected,
  now,
  objectCleanupNotBefore,
  prisma,
}: {
  id: string;
  userId: string;
  expected: StorageUploadAbandonExpectation & { abandonedAt: Date };
  now: Date;
  objectCleanupNotBefore: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (objectCleanupNotBefore.getTime() <= now.getTime()) {
    throw new RangeError("Terminal multipart object cleanup must be delayed");
  }

  const run = async (tx: PrismaTransaction): Promise<boolean> => {
    await tx.aiStorageCleanup.createMany({
      data: [{
        objectKey: expected.objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: objectCleanupNotBefore,
      }],
      skipDuplicates: true,
    });
    const cleanup = await tx.aiStorageCleanup.findFirst({
      where: { objectKey: expected.objectKey },
      select: {
        objectKey: true,
        leaseToken: true,
        notBefore: true,
      },
    });
    if (!cleanup) {
      throw new Error(
        `Object cleanup ${expected.objectKey} was not persisted`,
      );
    }
    if (
      cleanup.leaseToken &&
      cleanup.notBefore.getTime() > now.getTime()
    ) return false;

    const delayedUntil = cleanup.notBefore.getTime() >
        objectCleanupNotBefore.getTime()
      ? cleanup.notBefore
      : objectCleanupNotBefore;
    const delayed = await tx.aiStorageCleanup.updateMany({
      where: {
        objectKey: expected.objectKey,
        leaseToken: cleanup.leaseToken,
        notBefore: cleanup.notBefore,
      },
      data: {
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: delayedUntil,
      },
    });
    if (delayed.count !== 1) {
      throw new Error(
        `Object cleanup ${expected.objectKey} changed before it was delayed`,
      );
    }

    const deleted = await tx.storageUpload.deleteMany({
      where: {
        id,
        userId,
        completedFileId: null,
        abandonedAt: expected.abandonedAt,
        createdAt: expected.createdAt,
        objectKey: expected.objectKey,
        uploadId: expected.uploadId,
        name: expected.name,
        mimeType: expected.mimeType,
        size: expected.size,
        partSize: expected.partSize,
        startState: expected.startState,
        creationLeaseUntil: expected.creationLeaseUntil,
        creationLeaseToken: expected.creationLeaseToken,
        cleanupLeaseUntil: expected.cleanupLeaseUntil,
        cleanupLeaseToken: expected.cleanupLeaseToken,
      },
    });
    if (deleted.count !== 1) {
      // Roll back the newly-created cleanup as well. It may target a key now
      // owned by a replacement generation only in legacy deterministic rows.
      throw new Error(`Claimed storage upload ${id} changed before settlement`);
    }
    return true;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
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
  userId,
  fileId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  fileId: string;
  expected: StorageUploadGenerationExpectation;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: { completedFileId: fileId },
  });
  return result.count > 0;
}

export type StorageUploadGenerationExpectation = {
  createdAt: Date;
  objectKey: string;
  uploadId: string | null;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  startState: string;
  creationLeaseUntil: Date | null;
  creationLeaseToken: string | null;
};

// 「この行のパートは自分が捨てる」と宣言する。完了済みでも、既に誰かが宣言して
// いても取れない。取れた行にはもう控えを書けないので、そのあとで中止しても
// オブジェクトを消しても、File がそれを指すことはない。
export type StorageUploadAbandonExpectation =
  StorageUploadGenerationExpectation & {
    abandonedAt: Date | null;
    cleanupLeaseUntil: Date | null;
    cleanupLeaseToken: string | null;
  };

export async function claimStorageUploadForAbandon({
  id,
  userId,
  now,
  expected,
  cleanupLeaseToken,
  cleanupLeaseUntil,
  requireExpiredCreationLease = false,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  expected: StorageUploadAbandonExpectation;
  cleanupLeaseToken: string;
  cleanupLeaseUntil: Date;
  requireExpiredCreationLease?: boolean;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (
    cleanupLeaseToken.length === 0 ||
    cleanupLeaseUntil.getTime() <= now.getTime()
  ) {
    throw new RangeError("Storage cleanup lease must expire in the future");
  }
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: expected.abandonedAt,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      cleanupLeaseUntil: expected.cleanupLeaseUntil,
      cleanupLeaseToken: expected.cleanupLeaseToken,
      AND: [
        {
          OR: [
            { cleanupLeaseToken: null, cleanupLeaseUntil: null },
            { cleanupLeaseUntil: { lte: now } },
          ],
        },
        ...(requireExpiredCreationLease
          ? [{
              OR: [
                { creationLeaseUntil: null },
                { creationLeaseUntil: { lte: now } },
              ],
            }]
          : []),
      ],
    },
    data: {
      abandonedAt: expected.abandonedAt ?? now,
      cleanupLeaseToken,
      cleanupLeaseUntil,
    },
  });
  return result.count > 0;
}

/** Freeze an upload for an account cascade without claiming remote cleanup. */
export async function freezeStorageUploadForAccountDeletion({
  id,
  userId,
  now,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  expected: StorageUploadAbandonExpectation & { abandonedAt: null };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const frozen = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: { abandonedAt: now },
  });
  return frozen.count === 1;
}

// 取り消しの墓標の数。まだ現れていない名前の取り消しを書き留めたもので、
// 抱えているものは無い——だからこそ、いくらでも置けてしまってはいけない。
export async function countStorageUploadTombstonesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.count({
    where: { userId, uploadId: "", abandonedAt: { not: null } },
  });
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
  // 掃除に取られた行は数えない。ここで限っているのは「同時に走らせてよい本数」
  // で、取られた行はもう利用者のものではない——中止に失敗しているあいだ、その分
  // の容量は下の合計に出る。ここで数えると、片付けに失敗しているあいだ新しい
  // アップロードを始められなくなる。
  return await db.storageUpload.count({
    where: { userId, completedFileId: null, abandonedAt: null },
  });
}

// What a browser started and never finished, plus anything already claimed for
// clearing.
//
// A claimed row is one somebody already decided to destroy and could not — the
// bucket would not let go of the parts. Making it wait out the same day as an
// upload nobody has touched leaves that storage paid for, and the account's
// quota spent, for no reason: it is due now.
export async function listStorageUploadsStartedBefore({
  before,
  now,
  limit,
  prisma,
}: {
  before: Date;
  now: Date;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.findMany({
    where: {
      AND: [
        {
          OR: [
            { completedFileId: null, createdAt: { lt: before } },
            { abandonedAt: { not: null } },
          ],
        },
        {
          OR: [
            { cleanupLeaseUntil: null },
            { cleanupLeaseUntil: { lte: now } },
          ],
        },
        {
          OR: [
            { creationLeaseUntil: null },
            { creationLeaseUntil: { lte: now } },
          ],
        },
      ],
    },
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
    // 掃除に取られた行は数える——宣言しただけで、中止に失敗しているあいだその
    // パートはバケットに残っている。数えなければ、実際の使用量が枠の外に出る。
    where: { userId, completedFileId: null },
    _sum: { size: true },
  });
  return result._sum.size ?? BigInt(0);
}
