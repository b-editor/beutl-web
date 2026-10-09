import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function findAppReleaseAssetVersions({
  prisma,
}: {
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.appReleaseAsset.findMany({
    select: {
      version: true,
    },
  });
}

export async function findAppReleaseAssetsByVersion({
  version,
  prisma,
}: {
  version: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.appReleaseAsset.findMany({
    where: { version },
    select: {
      os: true,
      arch: true,
      type: true,
      standalone: true,
      url: true,
    },
  });
}

export async function findAppReleaseAsset({
  version,
  type,
  os,
  arch,
  standalone,
  prisma,
}: {
  version: string;
  type: string;
  os: string;
  arch: string;
  standalone: boolean;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.appReleaseAsset.findFirst({
    where: {
      version: version,
      type,
      os,
      arch,
      standalone,
    },
  });
}
