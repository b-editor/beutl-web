import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sign } from "hono/jwt";
import { routeGitRequest, type GitRouterEnvironment } from "@beutl/api/git/router";

export type GitRepositoryErrorCode =
  | "unavailable" | "requestFailed" | "unauthorized" | "notFound"
  | "invalidName" | "limitReached" | "conflict" | "accountChanged";

export class GitRepositoryError extends Error {
  constructor(public readonly code: GitRepositoryErrorCode) { super(code); }
}

const NAME_IDENTIFIER = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

/** Reuse the Web Worker's Git router and Next.js database provider in process. */
export async function gitRepositoryRequest(
  userId: string,
  suffix = "",
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  let env: GitRouterEnvironment;
  try { env = (await getCloudflareContext({ async: true })).env; }
  catch { throw new GitRepositoryError("unavailable"); }
  // next dev reads secrets from .env rather than Worker bindings. Its explicit
  // Git values override local Wrangler defaults, never production bindings.
  if (process.env.NODE_ENV === "development") {
    env = { ...env };
    for (const key of [
      "BEUTL_GIT_ENABLED", "BEUTL_GIT_TOKEN_SECRET", "BEUTL_GIT_S3_ENDPOINT",
      "BEUTL_GIT_S3_REGION", "BEUTL_GIT_S3_BUCKET", "BEUTL_GIT_S3_ACCESS_KEY_ID",
      "BEUTL_GIT_S3_SECRET_ACCESS_KEY", "BEUTL_GIT_S3_PATH_STYLE", "PUBLIC_ORIGIN",
    ] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new GitRepositoryError("unavailable");
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({
    [NAME_IDENTIFIER]: userId, iat: now, exp: now + 60,
    ...(process.env.JWT_ISSUER ? { iss: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { aud: process.env.JWT_AUDIENCE } : {}),
  }, secret, "HS256");
  const origin = env.PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net";
  const request = new Request(new URL(`/api/v3/repos${suffix}`, origin), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Cache-Control": "no-store" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  let response: Response;
  try {
    const result = await routeGitRequest(request, env);
    if (!result) throw new GitRepositoryError("unavailable");
    response = result;
  }
  catch (error) {
    if (error instanceof GitRepositoryError) throw error;
    throw new GitRepositoryError("requestFailed");
  }
  if (response.ok) return response;
  if (response.status === 401) throw new GitRepositoryError("unauthorized");
  if (response.status === 404) throw new GitRepositoryError(suffix ? "notFound" : "unavailable");
  if (response.status === 503) throw new GitRepositoryError("unavailable");
  if (response.status === 400) throw new GitRepositoryError("invalidName");
  if (response.status === 409) {
    const input = await response.json().catch(() => null) as { message?: string } | null;
    throw new GitRepositoryError(input?.message === "Repository limit reached" ? "limitReached" : "conflict");
  }
  throw new GitRepositoryError("requestFailed");
}
