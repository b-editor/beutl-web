import type { GitAccessTokenScope } from "@beutl/core";

export type GitScope = GitAccessTokenScope;

// Access tokens are opaque random strings; only their SHA-256 is stored.
const TOKEN_PREFIX = "bgt_";
const TOKEN_PATTERN = /^bgt_[A-Za-z0-9_-]{43}$/u;

export function generateGitAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function hashGitAccessToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Git and Git LFS send `https://USER:TOKEN@host/...` as Basic credentials; the
 * user name is ignored, and a token given as the user name with no password is
 * accepted too. API clients may send the token as a Bearer credential.
 */
export function gitAccessTokenFrom(authorization: string | null): string | null {
  const match = /^(Basic|Bearer)[\t ]+([^\s]+)[\t ]*$/iu.exec(authorization ?? "");
  if (!match) return null;
  let token = match[2];
  if (match[1].toLowerCase() === "basic") {
    let decoded: string;
    try { decoded = new TextDecoder().decode(Uint8Array.from(atob(token), (c) => c.charCodeAt(0))); }
    catch {
      // Malformed Basic credentials are no credentials.
      return null;
    }
    const separator = decoded.indexOf(":");
    const user = separator < 0 ? decoded : decoded.slice(0, separator);
    const password = separator < 0 ? "" : decoded.slice(separator + 1);
    token = password || user;
  }
  return TOKEN_PATTERN.test(token) ? token : null;
}
