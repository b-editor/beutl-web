import { createHash, randomBytes } from "node:crypto";
import { getDb, startRetryableTransaction } from "@beutl/db";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const summarySelect = { id: true, name: true, hint: true, canPush: true, createdAt: true, expiresAt: true } as const;

export class NugetTokenLimitError extends Error {
  constructor() { super("At most 20 active API keys are allowed"); }
}

export async function listNugetTokens(userId: string) {
  return (await getDb()).nugetToken.findMany({ where: { userId, revokedAt: null }, select: summarySelect, orderBy: { createdAt: "desc" } });
}

export async function createNugetToken(userId: string, name: string, canPush: boolean, days: number) {
  if (!name.trim() || name.length > 100 || !Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid API key settings");
  const secret = `bn_${randomBytes(32).toString("hex")}`;
  return startRetryableTransaction(async (tx) => {
    if (await tx.nugetToken.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }) >= 20) throw new NugetTokenLimitError();
    const row = await tx.nugetToken.create({ data: { userId, name: name.trim(), canPush, tokenHash: hash(secret), hint: secret.slice(-6),
      expiresAt: new Date(Date.now() + days * 86400000) }, select: summarySelect });
    return { ...row, secret };
  });
}

export async function revokeNugetToken(userId: string, id: string) {
  const { count } = await (await getDb()).nugetToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count > 0;
}

export function nugetCredential(headers: Headers): string | null {
  const key = headers.get("X-NuGet-ApiKey");
  if (key) return key;
  const basic = /^Basic\s+(\S+)\s*$/iu.exec(headers.get("Authorization") ?? "");
  if (!basic) return null;
  try {
    const decoded = atob(basic[1]);
    const colon = decoded.indexOf(":");
    return colon < 0 ? null : decoded.slice(colon + 1);
  } catch { return null; }
}

export async function authenticateNuget(headers: Headers) {
  const secret = nugetCredential(headers);
  if (!secret || !/^bn_[a-f0-9]{64}$/u.test(secret)) return null;
  const row = await (await getDb()).nugetToken.findUnique({ where: { tokenHash: hash(secret) },
    select: { userId: true, canPush: true, revokedAt: true, expiresAt: true } });
  return row && !row.revokedAt && row.expiresAt > new Date() ? { userId: row.userId, canPush: row.canPush } : null;
}
