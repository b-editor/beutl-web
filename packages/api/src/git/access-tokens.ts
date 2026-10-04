import {
  GIT_ACCESS_TOKEN_LIMIT,
  type CreatedGitAccessToken,
  type GitAccessTokenSummary,
} from "@beutl/core";
import { getDb, startRetryableTransaction } from "@beutl/db";
import { ownsActiveGitRepository } from "./repositories";
import { generateGitAccessToken, gitAccessTokenFrom, hashGitAccessToken, type GitScope } from "./tokens";

// Long-lived, revocable credentials for one repository. They never expire; a
// token stops working when it is revoked, its repository is deleted, or the
// repository no longer belongs to the account that created it.

type TokenRow = { id: string; name: string; scope: string; hint: string; createdAt: Date; lastUsedAt: Date | null };
const LAST_USED_PRECISION_MS = 60 * 60_000;

function summary(row: TokenRow): GitAccessTokenSummary {
  return {
    id: row.id, name: row.name, scope: row.scope === "write" ? "write" : "read", hint: row.hint,
    createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listGitAccessTokens(ownerId: string, repoId: string): Promise<GitAccessTokenSummary[] | null> {
  if (!await ownsActiveGitRepository(ownerId, repoId)) return null;
  const rows = await (await getDb()).gitAccessToken.findMany({
    where: { repoId, ownerId, revokedAt: null }, orderBy: { createdAt: "desc" }, take: GIT_ACCESS_TOKEN_LIMIT,
  });
  return rows.map(summary);
}

/** The secret is returned once; only its hash is kept. */
export async function createGitAccessToken(ownerId: string, repoId: string, name: string, scope: GitScope):
  Promise<{ status: "created"; token: CreatedGitAccessToken } | { status: "notFound" } | { status: "limitReached" }> {
  const token = generateGitAccessToken();
  const tokenHash = await hashGitAccessToken(token);
  return startRetryableTransaction(async (tx) => {
    const repository = await tx.gitRepository.findFirst({ where: { id: repoId, ownerId, deletedAt: null }, select: { id: true } });
    if (!repository) return { status: "notFound" };
    if (await tx.gitAccessToken.count({ where: { repoId, ownerId, revokedAt: null } }) >= GIT_ACCESS_TOKEN_LIMIT) {
      return { status: "limitReached" };
    }
    const row = await tx.gitAccessToken.create({ data: { repoId, ownerId, name, scope, tokenHash, hint: token.slice(-4) } });
    return { status: "created", token: { ...summary(row), token } };
  }, { isolationLevel: "Serializable" });
}

export async function revokeGitAccessToken(ownerId: string, repoId: string, tokenId: string): Promise<boolean> {
  const { count } = await (await getDb()).gitAccessToken.updateMany({
    where: { id: tokenId, repoId, ownerId, revokedAt: null }, data: { revokedAt: new Date() },
  });
  return count > 0;
}

/**
 * Resolves the credential of a Git or LFS request for `repoId`. Null means the
 * request is unauthenticated; `active: false` means the token is valid but its
 * repository is gone or changed owner.
 */
export async function findGitAccess(authorization: string | null, repoId: string):
  Promise<{ ownerId: string; scope: GitScope; active: boolean } | null> {
  const token = gitAccessTokenFrom(authorization);
  if (!token) return null;
  const db = await getDb();
  const row = await db.gitAccessToken.findUnique({
    where: { tokenHash: await hashGitAccessToken(token) },
    select: { id: true, repoId: true, ownerId: true, scope: true, revokedAt: true, lastUsedAt: true,
      repository: { select: { ownerId: true, deletedAt: true } } },
  });
  // An unknown stored scope grants nothing rather than falling back to read.
  if (!row || row.revokedAt || row.repoId !== repoId || (row.scope !== "read" && row.scope !== "write")) return null;
  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_PRECISION_MS) {
    // Concurrent Git requests race on this row; last use is advisory and never refuses a credential.
    await db.gitAccessToken.updateMany({
      where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_PRECISION_MS) } }] },
      data: { lastUsedAt: now },
    }).catch((error) => console.error("Git access token last-use update failed", { tokenId: row.id, error }));
  }
  return {
    ownerId: row.ownerId, scope: row.scope,
    active: row.repository.deletedAt === null && row.repository.ownerId === row.ownerId,
  };
}
