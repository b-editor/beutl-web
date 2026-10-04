"use server";

import { revalidatePath } from "next/cache";
import { authenticated } from "@/lib/auth-guard";
import { GitRepositoryError, gitRepositoryRequest } from "@/lib/git-repositories";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { isGitRepositoryId, isValidGitRepositoryName, type ActionResult, type GitRepositorySummary, type GitRepositoryToken } from "@beutl/core";

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
  return action(async (userId) => {
    const response = await gitRepositoryRequest(userId);
    const body = await response.json() as { repositories: GitRepositorySummary[] };
    return body.repositories;
  });
}

export async function createRepository(name: string, creationId: string, expectedOwnerId: string): Promise<ActionResult<GitRepositorySummary>> {
  return action(async (userId) => {
    if (userId !== expectedOwnerId) throw new GitRepositoryError("accountChanged");
    if (!isValidGitRepositoryName(name)) throw new GitRepositoryError("invalidName");
    if (!isGitRepositoryId(creationId)) throw new GitRepositoryError("conflict");
    const response = await gitRepositoryRequest(userId, "", "POST", { name: name.trim(), creationId, ownerId: userId });
    return await response.json() as GitRepositorySummary;
  }, true);
}

export async function renameRepository(id: string, name: string): Promise<ActionResult<GitRepositorySummary>> {
  return action(async (userId) => {
    if (!isValidGitRepositoryName(name)) throw new GitRepositoryError("invalidName");
    const response = await gitRepositoryRequest(userId, `/${repositoryId(id)}`, "PATCH", { name: name.trim() });
    return await response.json() as GitRepositorySummary;
  }, true);
}

export async function deleteRepository(id: string): Promise<ActionResult> {
  return action(async (userId) => {
    await gitRepositoryRequest(userId, `/${repositoryId(id)}`, "DELETE");
    return undefined;
  }, true);
}

export async function createRepositoryToken(id: string, scope: "read" | "write"): Promise<ActionResult<GitRepositoryToken>> {
  return action(async (userId) => {
    if (scope !== "read" && scope !== "write") throw new GitRepositoryError("requestFailed");
    const response = await gitRepositoryRequest(userId, `/${repositoryId(id)}/token`, "POST", { scope });
    return await response.json() as GitRepositoryToken;
  });
}
