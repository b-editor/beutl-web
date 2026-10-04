"use server";

import { revalidatePath } from "next/cache";
import { authenticated } from "@/lib/auth-guard";
import { GitRepositoryError, hostedGit } from "@/lib/git-repositories";
import {
  createGitRepository,
  deleteGitRepository,
  listGitRepositories,
  renameGitRepository,
} from "@beutl/api/git/repositories";
import { createGitAccessToken, listGitAccessTokens, revokeGitAccessToken } from "@beutl/api/git/access-tokens";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import {
  isGitRepositoryId,
  isValidGitAccessTokenName,
  isValidGitRepositoryName,
  type ActionResult,
  type CreatedGitAccessToken,
  type GitAccessTokenScope,
  type GitAccessTokenSummary,
  type GitRepositorySummary,
} from "@beutl/core";

async function action<T>(run: (userId: string) => Promise<T>, mutation = false): Promise<ActionResult<T>> {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const result = await authenticated(async (session) => {
    try {
      const data = await run(session.user.id);
      if (mutation) {
        revalidatePath(`/${lang}/dashboard/repositories`);
        revalidatePath(`/${lang}/dashboard/storage`);
      }
      return { success: true, data };
    } catch (error) {
      if (!(error instanceof GitRepositoryError)) {
        console.error("Git repository action failed", { type: error instanceof Error ? error.name : "unknown" });
      }
      return { success: false, message: t(`dashboard:repositories.errors.${error instanceof GitRepositoryError ? error.code : "requestFailed"}`) };
    }
  });
  return !result.success && result.message === "Unauthenticated"
    ? { success: false, message: t("dashboard:repositories.errors.unauthorized") }
    : result;
}

function repositoryId(id: string) {
  if (!isGitRepositoryId(id)) throw new GitRepositoryError("notFound");
  return id;
}

export async function retrieveRepositories(): Promise<ActionResult<GitRepositorySummary[]>> {
  return action(async (userId) => listGitRepositories(userId, (await hostedGit()).origin));
}

export async function createRepository(name: string, creationId: string, expectedOwnerId: string): Promise<ActionResult<GitRepositorySummary>> {
  return action(async (userId) => {
    if (userId !== expectedOwnerId) throw new GitRepositoryError("accountChanged");
    if (!isValidGitRepositoryName(name)) throw new GitRepositoryError("invalidName");
    if (!isGitRepositoryId(creationId)) throw new GitRepositoryError("conflict");
    const { origin } = await hostedGit();
    const result = await createGitRepository(userId, name.trim(), creationId, origin);
    if (result.status !== "created") throw new GitRepositoryError(result.status);
    return result.repository;
  }, true);
}

export async function renameRepository(id: string, name: string): Promise<ActionResult<GitRepositorySummary>> {
  return action(async (userId) => {
    if (!isValidGitRepositoryName(name)) throw new GitRepositoryError("invalidName");
    const repoId = repositoryId(id);
    const repository = await renameGitRepository(userId, repoId, name.trim(), (await hostedGit()).origin);
    if (!repository) throw new GitRepositoryError("notFound");
    return repository;
  }, true);
}

export async function deleteRepository(id: string): Promise<ActionResult> {
  return action(async (userId) => {
    const repoId = repositoryId(id);
    if (!await deleteGitRepository((await hostedGit()).env, userId, repoId)) throw new GitRepositoryError("notFound");
    return undefined;
  }, true);
}

export async function listRepositoryTokens(id: string): Promise<ActionResult<GitAccessTokenSummary[]>> {
  return action(async (userId) => {
    const repoId = repositoryId(id);
    await hostedGit();
    const tokens = await listGitAccessTokens(userId, repoId);
    if (!tokens) throw new GitRepositoryError("notFound");
    return tokens;
  });
}

/** The returned secret is shown once; only its hash is stored. */
export async function createRepositoryToken(id: string, name: string, scope: GitAccessTokenScope): Promise<ActionResult<CreatedGitAccessToken>> {
  return action(async (userId) => {
    const repoId = repositoryId(id);
    if (!isValidGitAccessTokenName(name)) throw new GitRepositoryError("invalidTokenName");
    if (scope !== "read" && scope !== "write") throw new GitRepositoryError("requestFailed");
    await hostedGit();
    const result = await createGitAccessToken(userId, repoId, name.trim(), scope);
    if (result.status === "notFound") throw new GitRepositoryError("notFound");
    if (result.status === "limitReached") throw new GitRepositoryError("tokenLimitReached");
    return result.token;
  });
}

export async function revokeRepositoryToken(id: string, tokenId: string): Promise<ActionResult> {
  return action(async (userId) => {
    const repoId = repositoryId(id);
    if (!isGitRepositoryId(tokenId)) throw new GitRepositoryError("notFound");
    await hostedGit();
    if (!await revokeGitAccessToken(userId, repoId, tokenId)) throw new GitRepositoryError("notFound");
    return undefined;
  });
}
