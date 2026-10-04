import { getDb, listExpiredGitLfsReservations } from "@beutl/db";
import { gitRepositoryObject, gitStorageConfigured, type GitEnvironment } from "./environment";

// Scheduled reconcilers. They run whenever storage is configured, independently
// of BEUTL_GIT_ENABLED, so disabling the API never strands deletions or quota.

export async function reconcileGitRepositoryDeletions(env: GitEnvironment): Promise<number> {
  if (!gitStorageConfigured(env)) return 0;
  const db = await getDb();
  const tombstones = await db.gitRepository.findMany({
    where: {
      OR: [{ deletedAt: { not: null } }, { ownerId: null }],
      cleanupCompleteAt: null,
    },
    select: { id: true, deletedAt: true, maintenanceFailures: true },
    orderBy: [{ maintenanceAttemptedAt: "asc" }, { id: "asc" }], take: 10,
  });
  let cleaned = 0;
  for (const row of tombstones) {
    try {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceAttemptedAt: new Date() } });
      if (!row.deletedAt) {
        await db.gitRepository.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
      }
      const { status } = await gitRepositoryObject(env, row.id).cleanup();
      if (status !== 204 && status !== 202) throw new Error("Git repository cleanup did not complete");
      if (status === 204) await db.gitRepository.update({
        where: { id: row.id }, data: { cleanupCompleteAt: new Date(), maintenanceFailures: 0 },
      });
      cleaned++;
    } catch (error) {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceFailures: { increment: 1 } } })
        .catch((failureError) => console.error("Failed to record Git cleanup failure", { repoId: row.id, error: failureError }));
      console.error("Git repository cleanup failed", { repoId: row.id, error,
        failures: row.maintenanceFailures + 1, interventionRequired: row.maintenanceFailures >= 4 });
    }
  }
  return cleaned;
}

export async function reconcileGitLfsReservations(env: GitEnvironment): Promise<number> {
  if (!gitStorageConfigured(env)) return 0;
  const db = await getDb();
  const rows = await listExpiredGitLfsReservations(new Date(), 20, db);
  let completed = 0;
  for (const row of rows) {
    try {
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid },
        data: { cleanupAttemptedAt: new Date() } });
      const result = await gitRepositoryObject(env, row.repoId).cleanupLfs(row.oid);
      if (result.status !== 204) throw new Error(`Git LFS reservation cleanup returned HTTP ${result.status}`);
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid }, data: { cleanupFailures: 0 } });
      completed++;
    } catch (error) {
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid },
        data: { cleanupFailures: { increment: 1 } } }).catch((failureError) => console.error("Failed to record LFS cleanup failure", { repoId: row.repoId, oid: row.oid, error: failureError }));
      console.error("Git LFS reservation cleanup failed", { repoId: row.repoId, oid: row.oid, error,
        failures: row.cleanupFailures + 1, interventionRequired: row.cleanupFailures >= 4 });
    }
  }
  return completed;
}

export async function reconcileGitHistoryReservations(env: GitEnvironment): Promise<number> {
  if (!gitStorageConfigured(env)) return 0;
  const db = await getDb();
  const rows = await db.gitRepository.findMany({
    where: { historyReservedBytes: { gt: 0 }, deletedAt: null, ownerId: { not: null },
      updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    orderBy: [{ maintenanceAttemptedAt: "asc" }, { id: "asc" }], take: 10,
    select: { id: true },
  });
  let completed = 0;
  for (const row of rows) {
    try {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceAttemptedAt: new Date() } });
      const result = await gitRepositoryObject(env, row.id).settleHistory();
      if (result.status !== 204) throw new Error(`Git history recovery returned HTTP ${result.status}`);
      completed++;
    } catch (error) { console.error("Git history recovery failed", { repoId: row.id, error }); }
  }
  return completed;
}
