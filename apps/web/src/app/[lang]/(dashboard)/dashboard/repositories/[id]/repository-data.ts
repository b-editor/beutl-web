import "server-only";
import { notFound } from "next/navigation";
import type { GitAccess, GitEnvironment } from "@beutl/api/git/environment";
import { findGitRepository } from "@beutl/api/git/repositories";
import { isGitRepositoryId, isGitRevision, isGitTreePath, type GitRepositorySummary } from "@beutl/core";
import { authOrSignIn } from "@/lib/auth-guard";
import { GitRepositoryError, hostedGit } from "@/lib/git-repositories";

export type LoadedRepository =
  | { status: "ready"; repository: GitRepositorySummary; env: GitEnvironment; access: GitAccess }
  | { status: "unavailable" };

/** The signed-in owner's repository; anyone else gets the same 404 as a missing one. */
export async function loadRepository(id: string): Promise<LoadedRepository> {
  const session = await authOrSignIn();
  if (!isGitRepositoryId(id)) notFound();
  let hosted: Awaited<ReturnType<typeof hostedGit>>;
  try {
    hosted = await hostedGit();
  } catch (error) {
    if (error instanceof GitRepositoryError) return { status: "unavailable" };
    throw error;
  }
  const repository = await findGitRepository(session.user.id, id, hosted.origin);
  if (!repository) notFound();
  return { status: "ready", repository, env: hosted.env, access: { repoId: id, ownerId: session.user.id, scope: "read" } };
}

/** The ref and path a URL asks for; anything malformed reads as not asked. */
export function requestedLocation(query: Record<string, string | string[] | undefined>) {
  return {
    ref: typeof query.ref === "string" && isGitRevision(query.ref) ? query.ref : undefined,
    path: typeof query.path === "string" && isGitTreePath(query.path) ? query.path : "",
    cursor: typeof query.cursor === "string" && /^[0-9a-f]{40}$/u.test(query.cursor) ? query.cursor : undefined,
  };
}
