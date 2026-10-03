import { getDb, runWithDbProvider, type PrismaClient } from "./provider";
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
  if (await tx.gitRepository.count({ where: { ownerId: userId, accountedAt: null, deletedAt: null } })) {
    throw new Error("Git account storage migration is pending");
  }
}

export async function createGitRepositoryForOwner(ownerId: string, name: string, limit = 20, prisma?: PrismaClient, creationId?: string) {
  const db = prisma ?? await getDb();
  return runWithDbProvider(async () => db, () => startRetryableTransaction(async (tx) => {
    await tx.user.update({ where: { id: ownerId }, data: { storageRevision: { increment: 1 } } });
    if (creationId) {
      const existing = await tx.gitRepository.findUnique({ where: { id: creationId } });
      if (existing) {
        if (existing.ownerId !== ownerId || existing.name !== name || existing.deletedAt !== null) {
          throw new Error("Repository creation identifier is already used");
        }
        return existing;
      }
    }
    const count = await tx.gitRepository.count({ where: { ownerId, deletedAt: null } });
    if (count >= limit) return null;
    return tx.gitRepository.create({ data: { ...(creationId ? { id: creationId } : {}), ownerId, name, accountedAt: new Date() } });
  }, { isolationLevel: "Serializable" }));
}

export async function adoptExistingGitLfs(input: {
  repoId: string; oid: string; ownerId: string; size: number; verified: boolean; expiresAt: number;
}): Promise<void> {
  const db = await getDb();
  const old = await db.gitLfsStorage.findUnique({ where: { repoId_oid: { repoId: input.repoId, oid: input.oid } } });
  if (old && (old.ownerId !== input.ownerId || old.size !== BigInt(input.size))) {
    throw new Error("Existing Git LFS account entry does not match repository state");
  }
  await db.gitLfsStorage.upsert({
    where: { repoId_oid: { repoId: input.repoId, oid: input.oid } },
    create: { repoId: input.repoId, oid: input.oid, ownerId: input.ownerId,
      size: BigInt(input.size), verified: input.verified, expiresAt: new Date(input.expiresAt) },
    update: { verified: input.verified, expiresAt: new Date(input.expiresAt) },
  });
}

export async function markGitRepositoryAccounted(repoId: string, ownerId: string): Promise<void> {
  const db = await getDb();
  const result = await db.gitRepository.updateMany({
    where: { id: repoId, ownerId, deletedAt: null }, data: { accountedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("Git repository changed during account reconciliation");
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
  const db = await getDb();
  const changed = await db.gitLfsStorage.updateMany({ where: { repoId, oid }, data: { verified: true } });
  if (changed.count !== 1) throw new Error("Git LFS account reservation is missing");
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
