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

export async function commitGitLfs(repoId: string, oid: string): Promise<void> {
  await startRetryableTransaction(async (tx) => {
    const reservation = await tx.gitLfsStorage.findUnique({ where: { repoId_oid: { repoId, oid } } });
    if (!reservation?.ownerId) throw new Error("Git LFS account reservation is missing");
    await lockStorageAccount(reservation.ownerId, tx);
    if (!await tx.gitRepository.findFirst({ where: { id: repoId, ownerId: reservation.ownerId, deletedAt: null } }))
      throw new Error("Git repository is unavailable for storage commit");
    // A successful account commit can precede the DO flag write. Its replay
    // must recover that receipt even if the account plan subsequently changed.
    if (reservation.verified) return;
    const [quota, used] = await Promise.all([
      resolveStorageQuota({ userId: reservation.ownerId, prisma: tx }), accountReserved(tx, reservation.ownerId),
    ]);
    if (used > BigInt(quota.quotaBytes)) throw new GitLfsQuotaExceededError();
    const changed = await tx.gitLfsStorage.updateMany({
      where: { repoId, oid, ownerId: reservation.ownerId, verified: false }, data: { verified: true },
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
