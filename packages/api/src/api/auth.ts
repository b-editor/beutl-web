import { decode, verify as jwtVerify } from "hono/jwt";
import type { Context } from "hono";

const nameIdentifierClaim =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

function hasValidNumericDateClaims(payload: Record<string, unknown>) {
  return ["exp", "nbf", "iat"].every((claim) => {
    const value = payload[claim];
    return (
      value === undefined ||
      (typeof value === "number" && Number.isFinite(value))
    );
  });
}

async function verifyBearer(authHeader: string | null) {
  if (!authHeader) return null;
  const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/iu.exec(authHeader);
  if (!match) return null;

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  try {
    const issuer = process.env.JWT_ISSUER;
    const audience = process.env.JWT_AUDIENCE;
    const payload = await jwtVerify(match[1], secret, {
      alg: "HS256",
      ...(issuer ? { iss: issuer } : {}),
      ...(audience ? { aud: audience } : {}),
    });
    if (!hasValidNumericDateClaims(payload)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      (payload.exp !== undefined && payload.exp <= now) ||
      (payload.nbf !== undefined && payload.nbf > now) ||
      (payload.iat !== undefined && payload.iat > now)
    ) {
      return null;
    }

    const userId = payload[nameIdentifierClaim];
    return typeof userId === "string" && userId.trim().length > 0
      ? userId
      : null;
  } catch {
    return null;
  }
}

export async function getUserId(c: Context) {
  return verifyBearer(c.req.header("Authorization") ?? null);
}

export async function getUserIdFromHeaders(headers: Headers) {
  return verifyBearer(headers.get("Authorization"));
}

export async function tryGetUserIdFromHeaders(headers: Headers) {
  return await getUserIdFromHeaders(headers);
}

export function getUserIdFromToken(token: string) {
  // Decode-only helper. Do not use for authorization because it does not verify the JWT signature.
  const { payload } = decode(token);
  const userId = payload[nameIdentifierClaim];
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("JWT does not contain a valid user identifier");
  }
  return userId;
}
