import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { gitAvailability, gitPublicOrigin, type GitEnvironment } from "@beutl/api/git/environment";

export class GitRepositoryError extends Error {
  constructor(
    public readonly code:
      | "unavailable" | "requestFailed" | "unauthorized" | "notFound"
      | "invalidName" | "limitReached" | "conflict" | "accountChanged"
      | "invalidTokenName" | "tokenLimitReached",
  ) { super(code); }
}

/**
 * The dashboard shares the Web Worker's Hosted Git bindings. next dev receives
 * the same values from apps/web/.env through Wrangler's platform proxy.
 */
export async function hostedGit(): Promise<{ env: GitEnvironment; origin: string }> {
  let env: GitEnvironment;
  try { env = (await getCloudflareContext({ async: true })).env; }
  catch { throw new GitRepositoryError("unavailable"); }
  if (gitAvailability(env) !== "ready") throw new GitRepositoryError("unavailable");
  return { env, origin: gitPublicOrigin(env, "https://beutl.beditor.net") };
}
