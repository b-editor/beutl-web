import { getDb } from "./provider";
import { deleteUnreferencedFileWithStorageCleanup } from "./file";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

export async function findReleaseForLibrary({
  id: latestReleaseId,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
  return db.release.findFirst({
    where: {
      id,
    },
    select: {
      packageId: true,
      version: true,
      file: {
        select: {
          id: true,
          objectKey: true,
          size: true,
          userId: true,
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
  return db.release.delete({
    where: {
      id,
    },
  });
}

/** Remove a release pointer and retire its artifact in one transaction. */
export async function deleteReleaseWithStorageCleanup({
  id,
  userId,
  prisma,
}: {
  id: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const release = await tx.release.findUnique({
      where: { id },
      select: {
        package: { select: { userId: true } },
        file: { select: { id: true, userId: true } },
      },
    });
    if (!release || release.package.userId !== userId) {
      throw new Error(`Release ${id} was not found`);
    }

    const deleted = await tx.release.delete({ where: { id } });
    if (release.file?.userId === userId) {
      await deleteUnreferencedFileWithStorageCleanup({
        fileId: release.file.id,
        userId,
        prisma: tx,
      });
    }
    return deleted;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}
