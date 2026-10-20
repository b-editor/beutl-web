import "server-only";
import { APIError, createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { consumeAuthEmailSendLimits, pruneAuthEmailSendLimits, type AuthEmailSendLimit } from "@beutl/db";

const RATE_LIMIT_CODE = "AUTH_EMAIL_RATE_LIMITED";

async function emailLimitKeys(
  email: string,
  headers: Headers,
  secret = process.env.BETTER_AUTH_SECRET,
) {
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
  return { ipKey, recipientKey };
}

async function consumeEmailLimits(limits: readonly AuthEmailSendLimit[]): Promise<void> {
  const now = new Date();
  const result = await consumeAuthEmailSendLimits(limits, now);
  if (!result.allowed) {
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { code: RATE_LIMIT_CODE, message: "Too many email requests. Please try again later." },
      { "Retry-After": String(result.retryAfter) },
    );
  }
  await pruneAuthEmailSendLimits(now);
}

/** One policy for HTTP endpoints, Server Actions, Web and Admin. */
export async function limitAuthEmailSend(
  email: string,
  headers: Headers,
  secret = process.env.BETTER_AUTH_SECRET,
): Promise<void> {
  const { ipKey, recipientKey } = await emailLimitKeys(email, headers, secret);
  await consumeEmailLimits([
    { key: `ip-minute:${ipKey}`, max: 20, windowMilliseconds: 60_000 },
    { key: `recipient-minute:${recipientKey}`, max: 5, windowMilliseconds: 60_000 },
    { key: `recipient-hour:${recipientKey}`, max: 20, windowMilliseconds: 60 * 60_000 },
  ]);
}

export async function limitFeedbackSend(headers: Headers): Promise<void> {
  const { ipKey } = await emailLimitKeys("", headers);
  // The sender's email is unverified. Use the trusted IP and a shared ceiling;
  // keep these counters separate so feedback cannot lock out sign-in emails.
  await consumeEmailLimits([
    { key: `feedback-ip-ten-minutes:${ipKey}`, max: 3, windowMilliseconds: 10 * 60_000 },
    { key: `feedback-ip-hour:${ipKey}`, max: 10, windowMilliseconds: 60 * 60_000 },
    { key: "feedback-global-hour", max: 100, windowMilliseconds: 60 * 60_000 },
  ]);
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
