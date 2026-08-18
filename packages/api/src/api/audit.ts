import type { Context } from "hono";
import { createAuditLog } from "@beutl/db";

/**
 * 監査ログを書く。
 *
 * `@beutl/next` 側の addAuditLog は next/headers に依存していて、独立 Worker で動く
 * こちらからは使えない。ヘッダの読み取り方だけを Hono の Context 向けに置き換えた
 * 同等品で、記録する項目は揃えてある。
 */
export async function addApiAuditLog(
  c: Context,
  {
    userId,
    action,
    details,
  }: { userId: string | null; action: string; details?: string },
) {
  await createAuditLog({
    userId,
    action,
    details,
    ipAddress:
      c.req.header("x-real-ip") ||
      c.req.header("X-Forwarded-For")?.split(",")[0],
    userAgent: c.req.header("User-Agent"),
    port: c.req.header("Mod-CF-Client-Port"),
  });
}
