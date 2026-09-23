import { Hono } from "hono";
import { sign } from "hono/jwt";
import { v3 } from "@beutl/api";
import { auth } from "@/lib/better-auth";
import { fromThisSite, unauthorizedResponse } from "@/lib/internal-request";

// The dashboard's way in to the AI endpoints, for the screens that show an
// answer while it is still arriving.
//
// The endpoints themselves take a bearer token, which a browser has none of:
// the site signs its users in with a cookie. Rather than teach the API to
// accept cookies — which would let any other site post a paid request from a
// signed-in visitor's browser — this hands the request on with a token minted
// here, for the user the session names and for the next minute only. The token
// is never sent to the browser.

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
const TOKEN_LIFETIME_SECONDS = 60;

const app = new Hono().basePath("/api/v3").route("/", v3);

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return unauthorizedResponse();

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return unauthorizedResponse();
  request.signal.throwIfAborted();

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
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
  request.signal.throwIfAborted();

  // The same request, at the same path under the API's own prefix, carrying the
  // token instead of the cookie. Everything past this point — what the request
  // may ask for, what it costs, what it gets back — is the API's to decide.
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api\/internal\/ai\//, "/api/v3/ai/");
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.delete("cookie");

  return await app.request(
    new Request(url, {
      method: "POST",
      headers,
      body: request.body,
      signal: request.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
}
