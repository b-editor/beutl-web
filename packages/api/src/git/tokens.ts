import { sign, verify } from "hono/jwt";

export type GitScope = "read" | "write";
const TOKEN_LIFETIME_SECONDS = 60 * 60;
const ISSUER = "beutl-hosted-git";
const MULTIPART_AUDIENCE = "beutl-lfs-multipart";
const MULTIPART_LIFETIME_SECONDS = 24 * 60 * 60;

export function gitTokenSecret(env: { BEUTL_GIT_TOKEN_SECRET?: string }): string {
  const secret = env.BEUTL_GIT_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("BEUTL_GIT_TOKEN_SECRET must contain at least 32 characters");
  }
  return secret;
}

export async function issueGitToken(
  secret: string,
  ownerId: string,
  repoId: string,
  scope: GitScope,
  now = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: string }> {
  const exp = now + TOKEN_LIFETIME_SECONDS;
  const token = await sign(
    { sub: ownerId, repo_id: repoId, scope, iss: ISSUER, aud: ISSUER, iat: now, nbf: now, exp },
    secret,
  );
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyGitToken(
  secret: string,
  authorization: string | null,
  repoId: string,
  requiredScope: GitScope,
  now = Math.floor(Date.now() / 1000),
): Promise<{ ownerId: string; scope: GitScope } | null> {
  const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/iu.exec(authorization ?? "");
  if (!match) return null;
  try {
    const payload = await verify(match[1], secret, {
      alg: "HS256",
      iss: ISSUER,
      aud: ISSUER,
    });
    if (
      typeof payload.sub !== "string" || payload.sub.length === 0 ||
      payload.repo_id !== repoId ||
      (payload.scope !== "read" && payload.scope !== "write") ||
      (requiredScope === "write" && payload.scope !== "write") ||
      typeof payload.exp !== "number" || payload.exp <= now ||
      typeof payload.nbf !== "number" || payload.nbf > now ||
      typeof payload.iat !== "number" || payload.iat > now
    ) return null;
    return { ownerId: payload.sub, scope: payload.scope };
  } catch {
    // A malformed/expired JWT is unauthenticated; do not log its token material.
    return null;
  }
}

export async function issueMultipartToken(
  secret: string, ownerId: string, repoId: string, oid: string,
  now = Math.floor(Date.now() / 1000),
  reservationExpiry = now + MULTIPART_LIFETIME_SECONDS,
): Promise<string> {
  return sign({
    sub: ownerId, repo_id: repoId, oid, scope: "multipart",
    iss: ISSUER, aud: MULTIPART_AUDIENCE,
    iat: now, nbf: now, exp: Math.min(now + MULTIPART_LIFETIME_SECONDS, reservationExpiry),
  }, secret);
}

export async function verifyMultipartToken(
  secret: string, authorization: string | null, repoId: string, oid: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ ownerId: string } | null> {
  const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/iu.exec(authorization ?? "");
  if (!match) return null;
  try {
    const payload = await verify(match[1], secret, {
      alg: "HS256", iss: ISSUER, aud: MULTIPART_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0 ||
        payload.repo_id !== repoId || payload.oid !== oid || payload.scope !== "multipart" ||
        typeof payload.exp !== "number" || payload.exp <= now ||
        typeof payload.nbf !== "number" || payload.nbf > now ||
        typeof payload.iat !== "number" || payload.iat > now) return null;
    return { ownerId: payload.sub };
  } catch {
    // A malformed/expired JWT is unauthenticated; do not log its token material.
    return null;
  }
}
