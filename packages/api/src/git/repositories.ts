import { GIT_REPOSITORY_LIMIT, type GitRepositorySummary, type GitRepositoryToken } from "@beutl/core";
import { createGitRepositoryForOwner, getDb } from "@beutl/db";
import { gitRepositoryObject, type GitEnvironment } from "./environment";
import { gitTokenSecret, issueGitToken, type GitScope } from "./tokens";

// Repository management shared by the public v3 API and the Web dashboard.
// Every query is scoped to the caller's account; another account's repository
// is indistinguishable from a missing one.

type RepositoryRow = { id: string; name: string; createdAt: Date; updatedAt: Date };

function summary(row: RepositoryRow, origin: string): GitRepositorySummary {
  return {
    id: row.id, name: row.name, url: `${origin}/api/v3/git/${row.id}.git`,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listGitRepositories(ownerId: string, origin: string): Promise<GitRepositorySummary[]> {
  const rows = await (await getDb()).gitRepository.findMany({
    where: { ownerId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: GIT_REPOSITORY_LIMIT,
  });
  return rows.map((row) => summary(row, origin));
}

export async function findGitRepository(ownerId: string, id: string, origin: string): Promise<GitRepositorySummary | null> {
  const row = await (await getDb()).gitRepository.findFirst({ where: { id, ownerId, deletedAt: null } });
  return row && summary(row, origin);
}

export async function ownsActiveGitRepository(ownerId: string, id: string): Promise<boolean> {
  return !!await (await getDb()).gitRepository.findFirst({
    where: { id, ownerId, deletedAt: null }, select: { id: true },
  });
}

/** A retried creationId returns the repository it created instead of a second one. */
export async function createGitRepository(ownerId: string, name: string, creationId: string | undefined, origin: string):
  Promise<{ status: "created"; repository: GitRepositorySummary } | { status: "limitReached" } | { status: "conflict" }> {
  try {
    const result = await createGitRepositoryForOwner(ownerId, name, GIT_REPOSITORY_LIMIT, creationId);
    return result.status === "created" ? { status: "created", repository: summary(result.repository, origin) } : result;
  } catch (error) {
    // Concurrent first uses of one creationId race on the primary key.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return { status: "conflict" };
    }
    throw error;
  }
}

export async function renameGitRepository(ownerId: string, id: string, name: string, origin: string): Promise<GitRepositorySummary | null> {
  try {
    // The owner and deletion filters make the update itself the authorization check.
    const row = await (await getDb()).gitRepository.update({ where: { id, ownerId, deletedAt: null }, data: { name } });
    return summary(row, origin);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025") return null;
    throw error;
  }
}

/** Soft-deletes first; storage cleanup that fails here is retried by the scheduled reconciler. */
export async function deleteGitRepository(env: GitEnvironment, ownerId: string, id: string): Promise<boolean> {
  const { count } = await (await getDb()).gitRepository.updateMany({
    where: { id, ownerId, deletedAt: null }, data: { deletedAt: new Date() },
  });
  if (count === 0) return false;
  try {
    await gitRepositoryObject(env, id).cleanup();
  } catch (error) {
    console.error("Git repository cleanup deferred", { repoId: id, error });
  }
  return true;
}

export async function issueGitRepositoryToken(env: GitEnvironment, ownerId: string, id: string, scope: GitScope): Promise<GitRepositoryToken | null> {
  if (!await ownsActiveGitRepository(ownerId, id)) return null;
  return issueGitToken(gitTokenSecret(env), ownerId, id, scope);
}
