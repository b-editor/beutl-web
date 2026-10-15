import { sign, verify } from "hono/jwt";
import { NUGET_ORIGIN } from "@beutl/core";

function secret() {
  const value = process.env.NUGET_DOWNLOAD_SECRET;
  if (!value) throw new Error("NUGET_DOWNLOAD_SECRET is not configured");
  return value;
}

/** Cookie-authenticated Web downloads cross the domain using a short-lived, file-bound ticket. */
export async function nugetFileUrl(fileId: string, userId?: string | null) {
  const url = new URL(`/v3/files/${encodeURIComponent(fileId)}`, process.env.NUGET_PUBLIC_ORIGIN || NUGET_ORIGIN);
  if (userId) url.searchParams.set("ticket", await sign({ sub: userId, fileId, aud: "nuget-download", exp: Math.floor(Date.now() / 1000) + 120 }, secret(), "HS256"));
  return url.toString();
}

export async function verifyDownloadTicket(ticket: string, fileId: string): Promise<string | null> {
  const signingSecret = secret();
  try {
    const payload = await verify(ticket, signingSecret, { alg: "HS256", aud: "nuget-download" });
    return payload.fileId === fileId && typeof payload.sub === "string" && typeof payload.exp === "number" &&
      payload.exp > Date.now() / 1000 ? payload.sub : null;
  } catch {
    // Invalid or expired tickets are authentication failures; do not log credentials.
    return null;
  }
}
