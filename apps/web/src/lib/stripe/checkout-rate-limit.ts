import "server-only";
import { createHash } from "@beutl/core";
import { consumeAuthEmailSendLimits, pruneAuthEmailSendLimits } from "@beutl/db";
import { getIP } from "better-auth/api";

export async function consumePackageCheckoutLimit(userId: string, headers: Headers) {
  // Only Cloudflare's overwritten header may establish an IP quota identity.
  // getIP also groups IPv6 addresses by /64, matching authentication limits.
  const ip = getIP(headers, {
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  }) ?? "no-trusted-ip";
  const [userKey, ipKey] = await Promise.all([createHash(userId), createHash(ip)]);
  const now = new Date();
  // Reuse the shared serializable counters with a separate checkout namespace.
  const result = await consumeAuthEmailSendLimits([
    { key: `checkout-user-minute:${userKey}`, max: 10, windowMilliseconds: 60_000 },
    { key: `checkout-user-hour:${userKey}`, max: 60, windowMilliseconds: 60 * 60_000 },
    { key: `checkout-ip-minute:${ipKey}`, max: 30, windowMilliseconds: 60_000 },
    { key: `checkout-ip-hour:${ipKey}`, max: 180, windowMilliseconds: 60 * 60_000 },
  ], now);
  if (result.allowed) await pruneAuthEmailSendLimits(now);
  return result;
}
