import { sign } from "hono/jwt";

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
const TOKEN_LIFETIME_SECONDS = 60;

/** A short-lived token for calls from the Web Worker to the desktop API Worker. */
export async function issueAiApiToken(userId: string): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");

  const now = Math.floor(Date.now() / 1000);
  return await sign(
    {
      [NAME_IDENTIFIER_CLAIM]: userId,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
      ...(process.env.JWT_ISSUER ? { iss: process.env.JWT_ISSUER } : {}),
      ...(process.env.JWT_AUDIENCE ? { aud: process.env.JWT_AUDIENCE } : {}),
    },
    secret,
    "HS256",
  );
}
