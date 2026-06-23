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

export async function findReleasesForPackage({
  packageId,
  published,
  prisma,
}: {
  packageId: string;
  published?: boolean;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.findMany({
    where: {
      packageId: packageId,
      published: published,
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

export async function findReleaseByPackageAndVersion({
  packageId,
  version,
  prisma,
}: {
  packageId: string;
  version: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.findFirst({
    where: {
      packageId: packageId,
      version: version,
    },
    select: {
      id: true,
      version: true,
      title: true,
      description: true,
      targetVersion: true,
      fileId: true,
      published: true,
    },
  });
}
