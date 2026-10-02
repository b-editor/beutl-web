import {
  commitGitLfs, releaseGitLfs, releaseGitRepositoryStorage,
  reserveGitHistory, reserveGitLfs, settleGitHistory,
  adoptExistingGitLfs, markGitRepositoryAccounted,
} from "@beutl/db";

export interface GitStorageAccounting {
  reserveLfs(input: { repoId: string; oid: string; ownerId: string; size: number; expiresAt: number }):
    Promise<"reserved" | "existing" | "overQuota">;
  commitLfs(repoId: string, oid: string): Promise<void>;
  releaseLfs(repoId: string, oid: string): Promise<void>;
  reserveHistory(repoId: string, ownerId: string): Promise<boolean>;
  settleHistory(repoId: string, bytes: number): Promise<void>;
  releaseRepository(repoId: string): Promise<void>;
  adoptLfs(input: { repoId: string; oid: string; ownerId: string; size: number; verified: boolean; expiresAt: number }): Promise<void>;
  markAccounted(repoId: string, ownerId: string): Promise<void>;
}

export const databaseGitStorageAccounting: GitStorageAccounting = {
  reserveLfs: reserveGitLfs,
  commitLfs: commitGitLfs,
  releaseLfs: releaseGitLfs,
  reserveHistory: reserveGitHistory,
  settleHistory: settleGitHistory,
  releaseRepository: releaseGitRepositoryStorage,
  adoptLfs: adoptExistingGitLfs,
  markAccounted: markGitRepositoryAccounted,
};
