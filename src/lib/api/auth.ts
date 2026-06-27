import "server-only";
import { decode, verify as jwtVerify } from "hono/jwt";
import type { Context } from "hono";

const nameIdentifierClaim =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

async function verifyBearer(authHeader: string | null) {
  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  const payload = await jwtVerify(token, process.env.JWT_SECRET as string, "HS256");
  return payload[nameIdentifierClaim] as string;
}

export async function getUserId(c: Context) {
  return verifyBearer(c.req.header("Authorization") ?? null);
}

export async function getUserIdFromHeaders(headers: Headers) {
  return verifyBearer(headers.get("Authorization"));
}

export async function tryGetUserIdFromHeaders(headers: Headers) {
  try {
    return await getUserIdFromHeaders(headers);
  } catch {
    return null;
  }
}

export function getUserIdFromToken(token: string) {
  // Decode-only helper. Do not use for authorization because it does not verify the JWT signature.
  const { payload } = decode(token);
  return payload[nameIdentifierClaim] as string;
}
