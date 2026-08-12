import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import {
  claimPendingStorageFileReference,
  enqueueFileCleanupIfUnreferenced,
} from "./storage-cleanup";

export class ReleaseArtifactConflictError extends Error {
  constructor() {
    super("The release artifact changed while it was being replaced.");
    this.name = "ReleaseArtifactConflictError";
  }
}

const marketplaceReleaseSelect = {
  id: true,
  version: true,
  title: true,
  description: true,
  targetVersion: true,
  fileId: true,
  packageSha256: true,
  approvedAnalyticsManifestSha256: true,
  file: {
    select: {
      id: true,
      sha256: true,
    },
  },
} as const;

const editorReleaseSelect = {
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
} as const;

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
    select: marketplaceReleaseSelect,
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
    select: marketplaceReleaseSelect,
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
      ...marketplaceReleaseSelect,
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
      published: true,
      fileId: true,
      file: {
        select: {
          size: true,
        },
      },
    },
  });
}

type ReleaseMetadata = Readonly<{
  title: string;
  description: string;
  targetVersion: string;
  published: boolean;
}>;

export async function updateReleaseMetadata({
  id,
  title,
  description,
  targetVersion,
  published,
  prisma,
}: ReleaseMetadata & {
  id: string;
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
    },
    select: editorReleaseSelect,
  });
}

export async function replaceReleaseArtifact({
  id,
  expectedFileId,
  metadata,
  artifact,
  prisma,
}: {
  id: string;
  expectedFileId: string | null;
  metadata: ReleaseMetadata;
  artifact: Readonly<{
    fileId: string;
    packageSha256: string;
    approvedAnalyticsManifestSha256: string | null;
  }>;
  prisma?: PrismaTransaction;
}) {
  const replace = async (tx: PrismaTransaction) => {
    const changed = await tx.release.updateMany({
      where: { id, fileId: expectedFileId },
      data: {
        ...metadata,
        fileId: artifact.fileId,
        packageSha256: artifact.packageSha256,
        approvedAnalyticsManifestSha256:
          artifact.approvedAnalyticsManifestSha256,
      },
    });
    if (changed.count !== 1) {
      throw new ReleaseArtifactConflictError();
    }

    await claimPendingStorageFileReference({
      fileId: artifact.fileId,
      prisma: tx,
    });
    if (expectedFileId) {
      await enqueueFileCleanupIfUnreferenced({
        fileId: expectedFileId,
        prisma: tx,
      });
    }
    return await tx.release.findUniqueOrThrow({
      where: { id },
      select: editorReleaseSelect,
    });
  };

  return prisma
    ? await replace(prisma)
    : await startRetryableTransaction(replace);
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
    select: editorReleaseSelect,
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

export async function deleteReleaseAndEnqueueArtifact({
  id,
  expectedFileId,
  prisma,
}: {
  id: string;
  expectedFileId: string | null;
  prisma?: PrismaTransaction;
}) {
  const remove = async (tx: PrismaTransaction) => {
    const deleted = await tx.release.deleteMany({
      where: { id, fileId: expectedFileId },
    });
    if (deleted.count !== 1) {
      throw new ReleaseArtifactConflictError();
    }
    if (expectedFileId) {
      await enqueueFileCleanupIfUnreferenced({
        fileId: expectedFileId,
        prisma: tx,
      });
    }
  };
  return prisma
    ? await remove(prisma)
    : await startRetryableTransaction(remove);
}
