import "server-only";
import { createAuditLog, type PrismaTransaction } from "@beutl/db";
import { headers } from "next/headers";

export { auditLogActions } from "@beutl/db";

export async function addAuditLog({
  userId,
  action,
  details,
  prisma,
}: {
  userId: string | null;
  action: string;
  details?: string;
  // 監査対象の書き込みと同じトランザクションに載せるために渡す。
  prisma?: PrismaTransaction;
}) {
  const h = await headers();

  const ipAddress = h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0];
  const userAgent = h.get("User-Agent");
  const port = h.get("Mod-CF-Client-Port");
  await createAuditLog({
    userId,
    action,
    details,
    ipAddress,
    userAgent,
    port,
    prisma,
  });
}
