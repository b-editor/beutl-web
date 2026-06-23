import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function findReleaseForLibrary({
  id: latestReleaseId,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.release.findFirst({
    where: {
      id: latestReleaseId,
    },
    select: {
      id: true,
      version: true,
      title: true,
      description: true,
      targetVersion: true,
      fileId: true,
    },
  });
}
