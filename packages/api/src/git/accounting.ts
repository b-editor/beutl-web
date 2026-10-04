import {
  commitGitLfs, extendGitLfsReservation, releaseGitLfs, releaseGitRepositoryStorage,
  reserveGitHistory, reserveGitLfs, settleGitHistory,
} from "@beutl/db";
import { runWithDbProvider, type PrismaClient } from "@beutl/db";
import { PrismaClient as DatabaseClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export interface GitDatabaseEnvironment {
  BEUTL_DATABASE_HYPERDRIVE?: { connectionString: string };
}

async function createGitDatabaseClient(env: GitDatabaseEnvironment): Promise<PrismaClient> {
  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  return new DatabaseClient({ adapter: new PrismaPg({ connectionString, maxUses: 1 }) });
}

// Durable Objects have their own isolate and do not enter Worker.fetch.
// Bind one lazy client to this queued invocation, then close it on completion.
export async function withGitDatabase<T>(
  env: GitDatabaseEnvironment, work: () => Promise<T>,
  createClient: () => Promise<PrismaClient> = () => createGitDatabaseClient(env),
): Promise<T> {
  let client: Promise<PrismaClient> | undefined;
  try {
    return await runWithDbProvider(() => client ??= createClient(), work);
  } finally {
    if (client) await (await client).$disconnect();
  }
}

export interface GitStorageAccounting {
  reserveLfs(input: { repoId: string; oid: string; ownerId: string; size: number; expiresAt: number }):
    Promise<"reserved" | "existing" | "overQuota">;
  commitLfs(repoId: string, oid: string): Promise<void>;
  extendLfs(repoId: string, oid: string, expiresAt: number): Promise<void>;
  releaseLfs(repoId: string, oid: string): Promise<void>;
  reserveHistory(repoId: string, ownerId: string, maxAdditionalBytes: number): Promise<boolean>;
  settleHistory(repoId: string, bytes: number): Promise<void>;
  releaseRepository(repoId: string): Promise<void>;
}

export const databaseGitStorageAccounting: GitStorageAccounting = {
  reserveLfs: reserveGitLfs,
  commitLfs: commitGitLfs,
  extendLfs: extendGitLfsReservation,
  releaseLfs: releaseGitLfs,
  reserveHistory: reserveGitHistory,
  settleHistory: settleGitHistory,
  releaseRepository: releaseGitRepositoryStorage,
};
