import "server-only";
import { APIError, createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { consumeAuthEmailSendLimits, pruneAuthEmailSendLimits } from "@beutl/db";

const RATE_LIMIT_CODE = "AUTH_EMAIL_RATE_LIMITED";

/** One policy for HTTP endpoints, Server Actions, Web and Admin. */
export async function limitAuthEmailSend(
  email: string,
  headers: Headers,
  secret = process.env.BETTER_AUTH_SECRET,
): Promise<void> {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
  // Cloudflare overwrites this header. X-Forwarded-For is client-controlled
  // behind an appending proxy and must not provide a new quota identity.
  const ip =
    getIP(headers, { advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } } }) ??
    "no-trusted-ip";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hash = async (value: string) => {
    const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const recipient = email.trim().toLowerCase();
  const [ipKey, recipientKey] = await Promise.all([
    hash(`ip:${ip}`),
    hash(`recipient:${recipient}`),
  ]);
  const now = new Date();
  const result = await consumeAuthEmailSendLimits(
    [
      { key: `ip-minute:${ipKey}`, max: 20, windowMilliseconds: 60_000 },
      { key: `recipient-minute:${recipientKey}`, max: 5, windowMilliseconds: 60_000 },
      { key: `recipient-hour:${recipientKey}`, max: 20, windowMilliseconds: 60 * 60_000 },
    ],
    now,
  );
  if (!result.allowed) {
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { code: RATE_LIMIT_CODE, message: "Too many email requests. Please try again later." },
      { "Retry-After": String(result.retryAfter) },
    );
  }
  await pruneAuthEmailSendLimits(now);
}

// Better Auth's router limiter is skipped by auth.api, but endpoint hooks run
// for both entry points. Refuse before a verification token or email is made.
export const authEmailRateLimitHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-in/magic-link" && typeof ctx.body?.email === "string") {
    await limitAuthEmailSend(ctx.body.email, ctx.headers ?? new Headers(), ctx.context.secret);
  }
});

export function isAuthEmailRateLimitError(error: unknown): boolean {
  return isAPIError(error) && error.statusCode === 429;
}
