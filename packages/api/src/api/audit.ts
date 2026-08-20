import type { Context } from "hono";
import { createAuditLog } from "@beutl/db";

/**
 * 監査ログを書く。
 *
 * `@beutl/next` 側の addAuditLog は next/headers に依存していて、独立 Worker で動く
 * こちらからは使えない。ヘッダの読み取り方だけを Hono の Context 向けに置き換えた
 * 同等品で、記録する項目は揃えてある。
 *
 * 書けなくても投げない。呼ぶのは既に済んだ操作の後で、ここで投げると 500 を返す
 * ことになる。トークンの発行なら、有効なトークンを作った後で平文を渡せなくなり、
 * 利用者はそれを失効させることもできない。記録の欠落より悪い。
 */
export async function addApiAuditLog(
  c: Context,
  {
    userId,
    action,
    details,
  }: { userId: string | null; action: string; details?: string },
) {
  try {
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
  } catch (error) {
    console.error(`failed to write the audit log for ${action}`, error);
  }
}
