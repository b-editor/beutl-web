import "server-only";
import { verify as jwtVerify } from 'hono/jwt'; 
import type { Context } from "hono";

export async function getUserId(c: Context) {
  const header = c.req.header("Authentication");
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.split(" ")[1];
  const payload = await jwtVerify(token, process.env.JWT_SECRET as string);
  return payload["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] as string;
}
