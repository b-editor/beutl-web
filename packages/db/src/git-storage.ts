import type { GitRepository } from "@prisma/client";
import { getDb } from "./provider";
import { resolveStorageQuota } from "./storage-quota";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

// The account meter is logical current data: ordinary File bytes, current Git
// objects, and one copy of each LFS OID in each repository. Pending writes are
// reserved separately. Noncurrent B2 versions are a GC obligation, not usage
// a user can intentionally retain.
export async function sumGitCommittedBytes(userId: string, tx?: PrismaTransaction): Promise<bigint> {
  const db = tx ?? await getDb();
  const [lfs, history] = await Promise.all([
    db.gitLfsStorage.aggregate({ where: { ownerId: userId, verified: true }, _sum: { size: true } }),
    db.gitRepository.aggregate({ where: { ownerId: userId }, _sum: { historyBytes: true } }),
  ]);
  return (lfs._sum.size ?? BigInt(0)) + (history._sum.historyBytes ?? BigInt(0));
}

export async function sumGitReservedBytes(userId: string, tx?: PrismaTransaction): Promise<bigint> {
  const db = tx ?? await getDb();
  const [lfs, history] = await Promise.all([
    db.gitLfsStorage.aggregate({ where: { ownerId: userId, verified: false }, _sum: { size: true } }),
    db.gitRepository.aggregate({ where: { ownerId: userId }, _sum: { historyReservedBytes: true } }),
  ]);
  return (lfs._sum.size ?? BigInt(0)) + (history._sum.historyReservedBytes ?? BigInt(0));
}

export async function lockStorageAccount(userId: string, tx: PrismaTransaction): Promise<void> {
  // Cockroach transactions for File and Git admission write the same row. A
  // concurrent check therefore retries instead of both accepting stale sums.
  await tx.user.update({ where: { id: userId }, data: { storageRevision: { increment: 1 } } });
}

/** A retried creationId returns its repository; any other reuse is a conflict. */
export async function createGitRepositoryForOwner(ownerId: string, name: string, limit: number, creationId?: string):
  Promise<{ status: "created"; repository: GitRepository } | { status: "limitReached" } | { status: "conflict" }> {
  return startRetryableTransaction(async (tx) => {
    await lockStorageAccount(ownerId, tx);
    if (creationId) {
      const existing = await tx.gitRepository.findUnique({ where: { id: creationId } });
      if (existing) {
        return existing.ownerId === ownerId && existing.name === name && existing.deletedAt === null
          ? { status: "created", repository: existing }
          : { status: "conflict" };
      }
    }
    const count = await tx.gitRepository.count({ where: { ownerId, deletedAt: null } });
    if (count >= limit) return { status: "limitReached" };
    return {
      status: "created",
      repository: await tx.gitRepository.create({ data: { ...(creationId ? { id: creationId } : {}), ownerId, name } }),
    };
  }, { isolationLevel: "Serializable" });
}

async function accountReserved(tx: PrismaTransaction, userId: string): Promise<bigint> {
  if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === "function") {
    const rows = await tx.$queryRaw<Array<{ total: bigint | number | string }>>`
      SELECT (
        COALESCE((SELECT SUM("f"."size") FROM "File" AS "f"
          WHERE "f"."userId" = ${userId}
            AND NOT EXISTS (SELECT 1 FROM "AiJob" AS "j" WHERE "j"."resultFileId" = "f"."id")), 0)::INT8
        + COALESCE((SELECT SUM("size") FROM "StorageUpload"
          WHERE "userId" = ${userId} AND "completedFileId" IS NULL), 0)::INT8
        + COALESCE((SELECT SUM("size") FROM "GitLfsStorage"
          WHERE "ownerId" = ${userId}), 0)::INT8
        + COALESCE((SELECT SUM("historyBytes" + "historyReservedBytes") FROM "GitRepository"
          WHERE "ownerId" = ${userId}), 0)::INT8
      ) AS "total"
    `;
    return BigInt(rows[0]?.total ?? 0);
  }
  const [files, uploads, gitCommitted, gitReserved] = await Promise.all([
    tx.file.aggregate({ where: { userId, aiJobResult: null }, _sum: { size: true } }),
    tx.storageUpload.aggregate({ where: { userId, completedFileId: null }, _sum: { size: true } }),
    sumGitCommittedBytes(userId, tx), sumGitReservedBytes(userId, tx),
  ]);
  return (files._sum.size ?? BigInt(0)) + (uploads._sum.size ?? BigInt(0)) + gitCommitted + gitReserved;
}

export async function reserveGitLfs({ repoId, oid, ownerId, size, expiresAt }: {
  repoId: string; oid: string; ownerId: string; size: number; expiresAt: number;
}): Promise<"reserved" | "existing" | "overQuota"> {
  return startRetryableTransaction(async (tx) => {
    await lockStorageAccount(ownerId, tx);
    const repo = await tx.gitRepository.findFirst({ where: { id: repoId, ownerId, deletedAt: null }, select: { id: true } });
    if (!repo) throw new Error("Git repository is unavailable for storage reservation");
    const existing = await tx.gitLfsStorage.findUnique({ where: { repoId_oid: { repoId, oid } } });
    if (existing) {
      if (existing.ownerId !== ownerId || existing.size !== BigInt(size)) throw new Error("Git LFS reservation mismatch");
      return "existing";
    }
    const [quota, used] = await Promise.all([
      resolveStorageQuota({ userId: ownerId, prisma: tx }), accountReserved(tx, ownerId),
    ]);
    if (used + BigInt(size) > BigInt(quota.quotaBytes)) return "overQuota";
    await tx.gitLfsStorage.create({ data: { repoId, oid, ownerId, size: BigInt(size), expiresAt: new Date(expiresAt) } });
    return "reserved";
  });
}

export async function reserveGitLfsBatch({ repoId, ownerId, items, maxReservations = Infinity }: {
  repoId: string;
  ownerId: string;
  items: readonly { oid: string; size: number; expiresAt: number }[];
  maxReservations?: number;
}): Promise<Map<string, "reserved" | "existing" | "overQuota" | "limitReached">> {
  if (!items.length) return new Map();
  return startRetryableTransaction(async (tx) => {
    const unique = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      const first = unique.get(item.oid);
      if (!first) unique.set(item.oid, item);
      else if (first.size !== item.size) throw new Error("Git LFS reservation mismatch");
    }

    await lockStorageAccount(ownerId, tx);
    const repo = await tx.gitRepository.findFirst({ where: { id: repoId, ownerId, deletedAt: null }, select: { id: true } });
    if (!repo) throw new Error("Git repository is unavailable for storage reservation");
    const rows = await tx.gitLfsStorage.findMany({ where: { repoId, oid: { in: [...unique.keys()] } } });
    const existing = new Set<string>();
    for (const row of rows) {
      if (row.ownerId !== ownerId || row.size !== BigInt(unique.get(row.oid)!.size))
        throw new Error("Git LFS reservation mismatch");
      existing.add(row.oid);
    }

    let available = BigInt(0);
    if (existing.size < unique.size && maxReservations > 0) {
      const [quota, used] = await Promise.all([
        resolveStorageQuota({ userId: ownerId, prisma: tx }), accountReserved(tx, ownerId),
      ]);
      available = BigInt(quota.quotaBytes) - used;
    }
    const results = new Map<string, "reserved" | "existing" | "overQuota" | "limitReached">();
    const toCreate = [];
    let admitted = 0;
    for (const { oid, size, expiresAt } of unique.values()) {
      if (admitted >= maxReservations) {
        results.set(oid, "limitReached");
        continue;
      }
      if (existing.has(oid)) {
        results.set(oid, "existing");
        admitted++;
        continue;
      }
      const bytes = BigInt(size);
      if (bytes > available) {
        results.set(oid, "overQuota");
        continue;
      }
      available -= bytes;
      admitted++;
      results.set(oid, "reserved");
      toCreate.push({ repoId, oid, ownerId, size: bytes, expiresAt: new Date(expiresAt) });
    }
    if (toCreate.length) await tx.gitLfsStorage.createMany({ data: toCreate });
    return results;
  });
}

export async function commitGitLfs(repoId: string, oid: string): Promise<void> {
  // Committing flips an already-reserved row from pending to verified without
  // changing accountReserved, so Serializable isolation protects quota and
  // repository checks without serializing concurrent uploads on User.storageRevision.
  await startRetryableTransaction(async (tx) => {
    let ownerId: string;
    let used: bigint;
    if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === "function") {
      const rows = await tx.$queryRaw<Array<{
        ownerId: string | null;
        verified: boolean;
        repoActive: boolean;
        used: bigint | number | string;
      }>>`
        SELECT
          "r"."ownerId" AS "ownerId",
          "r"."verified" AS "verified",
          EXISTS (
            SELECT 1 FROM "GitRepository" AS "g"
            WHERE "g"."id" = "r"."repoId" AND "g"."ownerId" = "r"."ownerId" AND "g"."deletedAt" IS NULL
          ) AS "repoActive",
          CASE WHEN "r"."verified" THEN 0::INT8 ELSE (
            COALESCE((SELECT SUM("f"."size") FROM "File" AS "f"
              WHERE "f"."userId" = "r"."ownerId"
                AND NOT EXISTS (SELECT 1 FROM "AiJob" AS "j" WHERE "j"."resultFileId" = "f"."id")), 0)::INT8
            + COALESCE((SELECT SUM("size") FROM "StorageUpload"
              WHERE "userId" = "r"."ownerId" AND "completedFileId" IS NULL), 0)::INT8
            + COALESCE((SELECT SUM("size") FROM "GitLfsStorage"
              WHERE "ownerId" = "r"."ownerId"), 0)::INT8
            + COALESCE((SELECT SUM("historyBytes" + "historyReservedBytes") FROM "GitRepository"
              WHERE "ownerId" = "r"."ownerId"), 0)::INT8
          ) END AS "used"
        FROM "GitLfsStorage" AS "r"
        WHERE "r"."repoId" = ${repoId} AND "r"."oid" = ${oid}
      `;
      const row = rows[0];
      if (!row?.ownerId) throw new Error("Git LFS account reservation is missing");
      if (!row.repoActive) throw new Error("Git repository is unavailable for storage commit");
      // A successful account commit can precede the DO flag write. Its replay
      // must recover that receipt even if the account plan subsequently changed.
      if (row.verified) return;
      ownerId = row.ownerId;
      used = BigInt(row.used);
    } else {
      const reservation = await tx.gitLfsStorage.findUnique({ where: { repoId_oid: { repoId, oid } } });
      if (!reservation?.ownerId) throw new Error("Git LFS account reservation is missing");
      if (!await tx.gitRepository.findFirst({ where: { id: repoId, ownerId: reservation.ownerId, deletedAt: null } }))
        throw new Error("Git repository is unavailable for storage commit");
      // A successful account commit can precede the DO flag write. Its replay
      // must recover that receipt even if the account plan subsequently changed.
      if (reservation.verified) return;
      ownerId = reservation.ownerId;
      used = await accountReserved(tx, ownerId);
    }
    const quota = await resolveStorageQuota({ userId: ownerId, prisma: tx });
    if (used > BigInt(quota.quotaBytes)) throw new GitLfsQuotaExceededError();
    const changed = await tx.gitLfsStorage.updateMany({
      where: { repoId, oid, ownerId, verified: false }, data: { verified: true },
    });
    if (changed.count !== 1) throw new Error("Git LFS account reservation changed before commit");
  }, { isolationLevel: "Serializable" });
}

class GitLfsQuotaExceededError extends RangeError {
  constructor() { super("Account storage quota exceeded at LFS completion"); }
}

/** Moves a pending reservation's expiry while its upload is still making progress. */
export async function extendGitLfsReservation(repoId: string, oid: string, expiresAt: number): Promise<void> {
  const db = await getDb();
  await db.gitLfsStorage.updateMany({ where: { repoId, oid, verified: false }, data: { expiresAt: new Date(expiresAt) } });
}

export async function releaseGitLfs(repoId: string, oid: string): Promise<void> {
  const db = await getDb();
  // The account commit can succeed before the DO's verified flag is saved.
  // Callers release only after every physical B2 version was deleted, so this
  // must also clear a stranded committed entry.
  await db.gitLfsStorage.deleteMany({ where: { repoId, oid } });
}

export async function listExpiredGitLfsReservations(now = new Date(), take = 20, prisma?: PrismaTransaction):
  Promise<Array<{ repoId: string; oid: string; cleanupFailures: number }>> {
  const db = prisma ?? await getDb();
  const rows = await db.gitLfsStorage.findMany({
    where: { verified: false, expiresAt: { lt: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
    select: { repoId: true, oid: true, cleanupFailures: true },
    orderBy: [{ cleanupAttemptedAt: "asc" }, { repoId: "asc" }, { oid: "asc" }], take,
  });
  return rows;
}

export async function reserveGitHistory(repoId: string, ownerId: string, maxAdditionalBytes = 16 * 1024 * 1024): Promise<boolean> {
  if (!Number.isSafeInteger(maxAdditionalBytes) || maxAdditionalBytes < 0 || maxAdditionalBytes > 16 * 1024 * 1024) {
    throw new RangeError("Invalid Git history reservation bound");
  }
  return startRetryableTransaction(async (tx) => {
    await lockStorageAccount(ownerId, tx);
    const repo = await tx.gitRepository.findFirst({ where: { id: repoId, ownerId, deletedAt: null } });
    if (!repo) throw new Error("Git repository is unavailable for history reservation");
    if (repo.historyReservedBytes > BigInt(0)) throw new Error("Git history requires reconciliation");
    const remaining = BigInt(16 * 1024 * 1024) - repo.historyBytes;
    if (remaining < BigInt(0)) throw new Error("Git history exceeds its repository limit");
    const requested = BigInt(maxAdditionalBytes);
    const reservation = requested < remaining ? requested : remaining;
    const [quota, used] = await Promise.all([
      resolveStorageQuota({ userId: ownerId, prisma: tx }), accountReserved(tx, ownerId),
    ]);
    if (used + reservation > BigInt(quota.quotaBytes)) return false;
    await tx.gitRepository.update({ where: { id: repoId }, data: { historyReservedBytes: reservation } });
    return true;
  });
}

export async function settleGitHistory(repoId: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024) {
    throw new RangeError("Git history accounting exceeds its repository limit");
  }
  const db = await getDb();
  await db.gitRepository.update({ where: { id: repoId }, data: { historyBytes: BigInt(bytes), historyReservedBytes: BigInt(0) } });
}

export async function releaseGitRepositoryStorage(repoId: string): Promise<void> {
  await startRetryableTransaction(async (tx) => {
    await tx.gitLfsStorage.deleteMany({ where: { repoId } });
    await tx.gitRepository.update({ where: { id: repoId }, data: { historyBytes: BigInt(0), historyReservedBytes: BigInt(0) } });
  });
}
