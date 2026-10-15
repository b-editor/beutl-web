import { getDb } from "./provider";
import { deleteUnreferencedFileWithStorageCleanup } from "./file";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { normalizeNugetId, normalizeNugetVersion, type NugetMetadata } from "@beutl/core";

export class ReleaseArtifactLockedError extends Error {
  constructor() { super("Published release files cannot be replaced. Create a new version."); }
}

export class ReleaseIdentityConflictError extends Error {
  constructor() { super("This package version already exists or was previously published."); }
}

export async function reservePublishedReleaseIdentity(
  tx: PrismaTransaction,
  release: { id: string; packageId: string; version: string },
) {
  const pkg = await tx.package.findUniqueOrThrow({ where: { id: release.packageId }, select: { name: true } });
  const name = normalizeNugetId(pkg.name), version = normalizeNugetVersion(release.version);
  const reservation = await tx.publishedPackageVersion.upsert({
    where: { name_version: { name, version } },
    create: { name, version, releaseId: release.id },
    update: {},
  });
  if (reservation.releaseId !== release.id) throw new ReleaseIdentityConflictError();
}

export type ReleaseNugetData = { metadata: NugetMetadata; nuspec: string; readme: string | null };

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
      published: true,
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
      published: true,
      artifactLocked: true,
      package: { select: { audience: true } },
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
  nuget,
  prisma,
}: {
  id: string;
  title: string;
  description: string;
  targetVersion: string;
  published: boolean;
  fileId: string | undefined;
  nuget?: ReleaseNugetData;
  prisma?: PrismaTransaction;
}) {
  const run = async (db: PrismaTransaction) => {
    const current = await db.release.findUniqueOrThrow({ where: { id } });
    if ((current.artifactLocked || current.published) &&
        ((fileId !== undefined && fileId !== current.fileId) || nuget)) {
      throw new ReleaseArtifactLockedError();
    }
    if (published) {
      if (!(fileId ?? current.fileId)) throw new Error("A published release requires a file");
      await reservePublishedReleaseIdentity(db, current);
    }
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
        ...(published ? { artifactLocked: true } : {}),
        ...(nuget ? {
          nugetVersion: normalizeNugetVersion(current.version),
          nugetMetadata: nuget.metadata,
          nuspec: nuget.nuspec,
          readme: nuget.readme,
        } : {}),
      },
      select: {
        version: true,
        title: true,
        description: true,
        targetVersion: true,
        id: true,
        published: true,
        artifactLocked: true,
        file: {
          select: {
            name: true,
          },
        },
      },
    });
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
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
  const run = async (db: PrismaTransaction) => {
    const nugetVersion = normalizeNugetVersion(version);
    const pkg = await db.package.findUniqueOrThrow({ where: { id: packageId }, select: { name: true } });
    const used = await db.publishedPackageVersion.findUnique({
      where: { name_version: { name: normalizeNugetId(pkg.name), version: nugetVersion } },
    });
    const versions = await db.release.findMany({ where: { packageId }, select: { version: true } });
    if (used || versions.some((r) => normalizeNugetVersion(r.version) === nugetVersion)) throw new ReleaseIdentityConflictError();
    // Files are attached through updateRelease's transactional publication path.
    if (published) throw new Error("Create a draft and attach its file before publishing");
    return db.release.create({
      data: {
        packageId,
        version,
        nugetVersion,
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
        artifactLocked: true,
        file: {
          select: {
            name: true,
          },
        },
      },
    });
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
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
        id: true,
        packageId: true,
        version: true,
        artifactLocked: true,
        published: true,
        package: { select: { userId: true } },
        file: { select: { id: true, userId: true } },
      },
    });
    if (!release || release.package.userId !== userId) {
      throw new Error(`Release ${id} was not found`);
    }

    if (release.artifactLocked || release.published) await reservePublishedReleaseIdentity(tx, release);
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
