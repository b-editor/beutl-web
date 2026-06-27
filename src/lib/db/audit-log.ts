import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function createAuditLog({
  userId,
  action,
  details,
  ipAddress,
  userAgent,
  port,
  prisma,
}: {
  userId: string | null;
  action: string;
  details?: string | null;
  ipAddress: string | null | undefined;
  userAgent: string | null | undefined;
  port: string | null | undefined;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.auditLog.create({
    data: {
      userId,
      action,
      details,
      ipAddress,
      userAgent,
      port,
    },
  });
}
