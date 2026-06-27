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

export async function getReleaseWithFileById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.findFirst({
    where: {
      id,
    },
    select: {
      packageId: true,
      file: {
        select: {
          id: true,
          objectKey: true,
          size: true,
        },
      },
    },
  });
}

export async function getReleasePublishedByIdOrThrow({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.findFirstOrThrow({
    where: {
      id,
    },
    select: {
      published: true,
    },
  });
}

export async function updateRelease({
  id,
  title,
  description,
  targetVersion,
  published,
  fileId,
  prisma,
}: {
  id: string;
  title: string;
  description: string;
  targetVersion: string;
  published: boolean;
  fileId: string | undefined;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.update({
    where: {
      id,
    },
    data: {
      title,
      description,
      targetVersion,
      published,
      fileId,
    },
    select: {
      version: true,
      title: true,
      description: true,
      targetVersion: true,
      id: true,
      published: true,
      file: {
        select: {
          name: true,
        },
      },
    },
  });
}

export async function createRelease({
  packageId,
  version,
  title,
  description,
  targetVersion,
  published,
  prisma,
}: {
  packageId: string;
  version: string;
  title: string;
  description: string;
  targetVersion: string;
  published: boolean;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.create({
    data: {
      packageId,
      version,
      title,
      description,
      targetVersion,
      published,
    },
    select: {
      version: true,
      title: true,
      description: true,
      targetVersion: true,
      id: true,
      published: true,
      file: {
        select: {
          name: true,
        },
      },
    },
  });
}

export async function getReleasePackageAndFileId({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.findFirst({
    where: {
      id,
    },
    select: {
      packageId: true,
      fileId: true,
    },
  });
}

export async function deleteReleaseById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return db.release.delete({
    where: {
      id,
    },
  });
}
