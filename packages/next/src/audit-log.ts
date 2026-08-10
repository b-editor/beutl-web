import "server-only";
import { createAuditLog } from "@beutl/db";
import { headers } from "next/headers";

export { auditLogActions } from "@beutl/db";

export async function addAuditLog({
  userId,
  action,
  details,
}: {
  userId: string | null;
  action: string;
  details?: string;
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
  });
}
