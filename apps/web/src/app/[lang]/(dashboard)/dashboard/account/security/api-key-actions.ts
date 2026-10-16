"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authenticated } from "@/lib/auth-guard";
import { GitRepositoryError, hostedGit } from "@/lib/git-repositories";
import { createGitAccessToken, listAccountGitAccessTokens, revokeGitAccessToken } from "@beutl/api/git/access-tokens";
import { findGitRepository } from "@beutl/api/git/repositories";
import { createNugetToken, listNugetTokens, NugetTokenLimitError, revokeNugetToken } from "@beutl/api/nuget/tokens";
import { isGitRepositoryId, isValidGitAccessTokenName, type ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import type { AccountApiKeys, ApiKeySettings, ApiKeySummary, ApiKeyTarget, CreatedApiKey } from "./api-key-types";

const repositoryId = z.string().refine(isGitRepositoryId);
const name = z.string().trim().min(1).refine((value) => !/\p{Cc}/u.test(value));
const settings = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nuget"), name: name.max(100), scope: z.enum(["read", "push"]), days: z.number().int().min(1).max(365) }),
  z.object({ kind: z.literal("repository"), name: name.refine(isValidGitAccessTokenName), scope: z.enum(["read", "write"]), repositoryId }),
]);
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nuget"), id: z.string().uuid() }),
  z.object({ kind: z.literal("repository"), id: repositoryId, repositoryId }),
]);

class ApiKeyError extends Error {
  constructor(public readonly code: "invalidSettings" | "notFound" | "repositoryLimitReached") { super(code); }
}

async function action<T>(run: (userId: string) => Promise<T>, mutation = false): Promise<ActionResult<T>> {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const result = await authenticated(async (session) => {
    try {
      const data = await run(session.user.id);
      if (mutation) revalidatePath(`/${lang}/dashboard/account/security`);
      return { success: true as const, data };
    } catch (error) {
      const code = error instanceof ApiKeyError ? error.code
        : error instanceof NugetTokenLimitError ? "nugetLimitReached"
        : error instanceof GitRepositoryError && error.code === "unavailable" ? "gitUnavailable" : "requestFailed";
      if (code === "requestFailed") console.error("API key action failed", { type: error instanceof Error ? error.name : "unknown" });
      return { success: false as const, message: t(`account:apiKeys.errors.${code}`) };
    }
  }, true);
  return !result.success && result.message === "Unauthenticated"
    ? { success: false, message: t("account:apiKeys.errors.unauthorized") } : result;
}

function nugetSummary(row: Awaited<ReturnType<typeof listNugetTokens>>[number]): ApiKeySummary {
  return {
    kind: "nuget", id: row.id, name: row.name, hint: row.hint, scope: row.canPush ? "push" : "read",
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  };
}

export async function retrieveApiKeys(): Promise<ActionResult<AccountApiKeys>> {
  return action(async (userId) => {
    const [nuget, repositories, gitAvailable] = await Promise.all([
      listNugetTokens(userId), listAccountGitAccessTokens(userId),
      hostedGit().then(() => true).catch((error) => {
        if (error instanceof GitRepositoryError && error.code === "unavailable") return false;
        throw error;
      }),
    ]);
    const keys: ApiKeySummary[] = [
      ...nuget.map(nugetSummary),
      ...repositories.flatMap((repository) => repository.tokens.map((token): ApiKeySummary => ({
        ...token, kind: "repository", repositoryId: repository.id, repositoryName: repository.name,
      }))),
    ];
    keys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { keys, repositories: repositories.map(({ id, name }) => ({ id, name })), gitAvailable };
  });
}

/** Both services return the credential once; list responses contain summaries only. */
export async function createApiKey(input: ApiKeySettings): Promise<ActionResult<CreatedApiKey>> {
  return action(async (userId) => {
    const parsed = settings.safeParse(input);
    if (!parsed.success) throw new ApiKeyError("invalidSettings");
    const data = parsed.data;
    if (data.kind === "nuget") {
      const row = await createNugetToken(userId, data.name, data.scope === "push", data.days);
      return { key: nugetSummary(row), secret: row.secret };
    }
    const { origin } = await hostedGit();
    const repository = await findGitRepository(userId, data.repositoryId, origin);
    if (!repository) throw new ApiKeyError("notFound");
    const result = await createGitAccessToken(userId, repository.id, data.name, data.scope);
    if (result.status === "notFound") throw new ApiKeyError("notFound");
    if (result.status === "limitReached") throw new ApiKeyError("repositoryLimitReached");
    const { token, ...summary } = result.token;
    return { key: { ...summary, kind: "repository", repositoryId: repository.id, repositoryName: repository.name }, secret: token, cloneUrl: repository.url };
  }, true);
}

export async function revokeApiKey(input: ApiKeyTarget): Promise<ActionResult> {
  return action(async (userId) => {
    const parsed = target.safeParse(input);
    if (!parsed.success) throw new ApiKeyError("invalidSettings");
    const data = parsed.data;
    const revoked = data.kind === "nuget" ? await revokeNugetToken(userId, data.id)
      : await revokeGitAccessToken(userId, data.repositoryId, data.id);
    if (!revoked) throw new ApiKeyError("notFound");
    return undefined;
  }, true);
}
