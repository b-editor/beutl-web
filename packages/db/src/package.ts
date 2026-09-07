import { getDb } from "./provider";
import type { PaymentInterval } from "@prisma/client";
import type { PrismaTransaction } from "./transaction";
import { startRetryableTransaction } from "./transaction";
import { preparePackageDeletionOutboxes } from "./package-checkout-attempt";
import {
  deleteUnreferencedFilesWithStorageCleanup,
  deleteUnreferencedFileWithStorageCleanup,
} from "./file";

export async function findPackageIdById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.package.findFirst({
    where: {
      id,
    },
    select: {
      id: true,
    },
  });
}

export async function findPackageBasicByName({
  name,
  prisma,
}: {
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.package.findFirst({
    where: {
      name: name,
    },
    select: {
      id: true,
      userId: true,
      published: true,
    },
  });
}

export async function getPackagePublishedByIdOrThrow({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.package.findFirstOrThrow({
    where: {
      id,
    },
    select: {
      published: true,
    },
  });
}

export async function findPackageForLibraryResponse({
  id: pkgId,
  currency,
  prisma,
}: {
  id: string;
  currency: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.package.findFirst({
    where: {
      id: pkgId,
    },
    select: {
      published: true,
      id: true,
      name: true,
      displayName: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
              displayName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      packagePricing: {
        where: currency ? {
          OR: [
            {
              currency: {
                equals: currency,
                mode: "insensitive",
              },
            },
            {
              fallback: true,
            },
          ],
        } : {
          fallback: true,
        },
        select: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      Release: {
        select: {
          id: true,
          version: true,
        },
      },
    },
  });
}

export async function existsPaidPricingForPackage({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.packagePricing.findFirst({
    where: {
      packageId: packageId,
      price: {
        gt: 0,
      },
    },
    select: {
      id: true,
    },
  });
}

export async function retrieveDevPackagesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.findMany({
    where: {
      userId: userId,
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      published: true,
      iconFile: {
        select: {
          id: true,
        },
      },
      Release: {
        select: {
          version: true,
        },
      },
    },
  });
}

export async function findPublishedPackageForLibrary({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.findFirst({
    where: {
      id,
      published: true,
    },
    select: {
      id: true,
      name: true,
      packagePricing: true,
    },
  });
}

export type BillingHistoryPackage = {
  id: string;
  name: string;
  displayName: string | null;
  user: {
    name: string | null;
    Profile: { displayName: string | null } | null;
  };
};

// Takes every package id on a billing history page at once. A per-row lookup
// turns the history into one query per purchase.
export async function findPackagesForBillingHistory({
  packageIds,
  prisma,
}: {
  packageIds: string[];
  prisma?: PrismaTransaction;
}): Promise<Map<string, BillingHistoryPackage>> {
  const uniqueIds = [...new Set(packageIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }
  const db = prisma || await getDb();
  const packages = await db.package.findMany({
    where: {
      id: { in: uniqueIds },
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      user: {
        select: {
          name: true,
          Profile: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
  });
  return new Map(packages.map((item) => [item.id, item]));
}

export async function retrievePublishedPackagesByUserName({
  userName,
  currency,
  prisma,
}: {
  userName: string;
  currency: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.findMany({
    where: {
      user: {
        Profile: {
          userName: userName,
        },
      },
      published: true,
    },
    select: {
      id: true,
      displayName: true,
      name: true,
      shortDescription: true,
      tags: true,
      iconFile: {
        select: {
          id: true,
        },
      },
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            },
          },
        },
      },
      packagePricing: {
        where: currency ? {
          OR: [
            {
              currency: {
                equals: currency,
                mode: "insensitive",
              },
            },
            {
              fallback: true,
            },
          ],
        } : {
          fallback: true,
        },
        select: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
    },
  });
}

/*
  Newest first, matching the store listing: there is no download count or
  rating on Package, so recency is the only ranking the schema supports.
*/
export async function retrieveLatestPublishedPackages({
  take,
  prisma,
}: {
  take: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.package.findMany({
    where: {
      published: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take,
    select: {
      id: true,
      name: true,
      displayName: true,
      shortDescription: true,
      iconFileId: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
              displayName: true,
            },
          },
        },
      },
    },
  });
}

export async function retrieveDevPackageByName({
  name,
  userId,
  prisma,
}: {
  name: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
      userId: userId,
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
      interval: true,
      packagePricing: {
        select: {
          id: true,
          price: true,
          currency: true,
          fallback: true,
        },
      },
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            },
          },
        },
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true,
        },
      },
      PackageScreenshot: {
        select: {
          order: true,
          file: {
            select: {
              id: true,
              objectKey: true,
            },
          },
        },
        orderBy: {
          order: "asc",
        },
      },
      Release: {
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
      },
    },
  });
}

export async function existsPackageName({
  name,
  prisma,
}: {
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.count({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
  });
}

export async function createDevPackage({
  name,
  userId,
  prisma,
}: {
  name: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.create({
    data: {
      name: name,
      userId: userId,
      description: "",
      shortDescription: "",
      webSite: "",
      published: false,
    },
  });
}

export async function getUserIdFromPackageId({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return (await db.package.findFirst({
      where: {
        id: packageId,
      },
      select: {
        userId: true,
      },
    }))?.userId;
}

export async function getPackageNameFromPackageId({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return (await db.package.findFirst({
      where: {
        id: packageId,
      },
      select: {
        name: true,
      },
    })
  )?.name;
}

export async function updateDevPackageDisplay({
  packageId,
  displayName,
  shortDescription,
  prisma,
}: {
  packageId: string;
  displayName: string;
  shortDescription: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: {
      id: packageId,
    },
    data: {
      displayName: displayName,
      shortDescription: shortDescription,
    },
    select: {
      name: true,
    },
  });
}

export async function updateDevPackageDescription({
  packageId,
  description,
  prisma,
}: {
  packageId: string;
  description: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: {
      id: packageId,
    },
    data: {
      description: description,
    },
    select: {
      name: true,
    },
  });
}

export async function updateDevPackagePublished({
  published,
  packageId,
  prisma,
}: {
  published: boolean;
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: {
      id: packageId,
    },
    data: {
      published: published,
    },
    select: {
      name: true,
    },
  });
}

export async function updateDevPackageIconFile({
  packageId,
  fileId,
  prisma,
}: {
  packageId: string;
  fileId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: {
      id: packageId,
    },
    data: {
      iconFileId: fileId,
    },
    select: {
      name: true,
    },
  });
}

/** Publish a newly-uploaded dedicated icon and retire the previous file atomically. */
export async function replaceDevPackageIconFile({
  packageId,
  fileId,
  prisma,
}: { packageId: string; fileId: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: packageId },
      select: { name: true, userId: true, iconFileId: true },
    });
    if (pkg.iconFileId === fileId) return pkg;
    const replacement = await tx.file.findUnique({ where: { id: fileId }, select: { userId: true } });
    if (!replacement || replacement.userId !== pkg.userId) {
      throw new Error("Dedicated icon file is not owned by the package user");
    }
    const old = pkg.iconFileId
      ? await tx.file.findUnique({ where: { id: pkg.iconFileId }, select: { objectKey: true } })
      : null;
    await tx.package.update({ where: { id: packageId }, data: { iconFileId: fileId } });
    if (old) {
      await deleteUnreferencedFileWithStorageCleanup({
        fileId: pkg.iconFileId!,
        userId: pkg.userId,
        prisma: tx,
      });
    }
    return pkg;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function retrieveDevPackageDependsFile({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  const pkg = await db.package.findFirstOrThrow({
    where: {
      id: packageId,
    },
    select: {
      PackageScreenshot: {
        select: {
          file: {
            select: {
              id: true,
              objectKey: true,
            },
          },
        },
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true,
        },
      },
      Release: {
        select: {
          file: {
            select: {
              id: true,
              objectKey: true,
            },
          },
        },
      },
    },
  });
  const files = pkg.PackageScreenshot.map((item) => item.file).concat(
    pkg.Release.map((item) => item.file as NonNullable<typeof item.file>),
  );
  if (pkg.iconFile) {
    files.push(pkg.iconFile);
  }
  return files;
}

export async function retrieveDevPackageIconFile({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return (await db.package.findFirst({
      where: {
        id: packageId,
      },
      select: {
        iconFile: {
          select: {
            id: true,
            objectKey: true,
            size: true,
          },
        },
      },
    })
  )?.iconFile;
}

export async function retrieveDevPackageScreenshots({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.packageScreenshot.findMany({
    where: {
      packageId: packageId,
    },
    select: {
      order: true,
      fileId: true,
    },
    orderBy: {
      order: "asc",
    },
  });
}

export async function retrieveDevPackageLastScreenshotOrder({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.packageScreenshot.findFirst({
    where: {
      packageId: packageId,
    },
    select: {
      order: true,
    },
    orderBy: {
      order: "desc",
    },
  });
}

export async function createDevPackageScreenshot({
  packageId,
  fileId,
  order,
  prisma,
}: {
  packageId: string;
  fileId: string;
  order: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  const ownership = await Promise.all([
    db.package.findUnique({ where: { id: packageId }, select: { userId: true } }),
    db.file.findUnique({ where: { id: fileId }, select: { userId: true } }),
  ]);
  if (!ownership[0] || !ownership[1] || ownership[0].userId !== ownership[1].userId) {
    throw new Error("Dedicated screenshot file is not owned by the package user");
  }
  return await db.packageScreenshot.upsert({
    where: { packageId_fileId: { packageId, fileId } },
    create: { packageId, fileId, order },
    update: { order },
  });
}

/** Replace one package's screenshot order without transiently violating its unique order. */
export async function reorderDevPackageScreenshots({
  packageId,
  orderedFileIds,
  prisma,
}: {
  packageId: string;
  orderedFileIds: string[];
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    await tx.package.update({
      where: { id: packageId },
      data: { updatedAt: new Date() },
    });
    const current = await tx.packageScreenshot.findMany({
      where: { packageId },
      select: { fileId: true },
    });
    const expected = new Set(current.map((item) => item.fileId));
    if (
      expected.size !== current.length ||
      orderedFileIds.length !== current.length ||
      new Set(orderedFileIds).size !== orderedFileIds.length ||
      orderedFileIds.some((fileId) => !expected.has(fileId))
    ) {
      throw new Error("Package screenshot order changed before publication");
    }

    for (let index = 0; index < current.length; index++) {
      await tx.packageScreenshot.update({
        where: { packageId_fileId: { packageId, fileId: current[index]!.fileId } },
        data: { order: -(index + 1) },
      });
    }
    for (let index = 0; index < orderedFileIds.length; index++) {
      await tx.packageScreenshot.update({
        where: { packageId_fileId: { packageId, fileId: orderedFileIds[index]! } },
        data: { order: index },
      });
    }
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function updateDevPackageTags({
  packageId,
  tags,
  prisma,
}: {
  packageId: string;
  tags: string[];
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: {
      id: packageId,
    },
    data: {
      tags: tags,
    },
    select: {
      name: true,
    },
  });
}

export async function deleteDevPackageScreenshot({
  packageId,
  fileId,
  prisma,
}: {
  packageId: string;
  fileId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.packageScreenshot.delete({
    where: {
      packageId_fileId: {
        packageId: packageId,
        fileId: fileId,
      },
    },
  });
}

/** Remove a screenshot relation and its file with a durable cleanup receipt. */
export async function deleteDevPackageScreenshotAndFile({
  packageId,
  fileId,
  prisma,
}: { packageId: string; fileId: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const relation = await tx.packageScreenshot.findUnique({
      where: { packageId_fileId: { packageId, fileId } },
      select: {
        package: { select: { userId: true } },
        file: { select: { userId: true } },
      },
    });
    if (!relation || relation.package.userId !== relation.file.userId) {
      throw new Error("Package screenshot relation was not found");
    }
    const deleted = await tx.packageScreenshot.deleteMany({ where: { packageId, fileId } });
    if (deleted.count !== 1) {
      throw new Error("Package screenshot relation changed before deletion");
    }
    await deleteUnreferencedFileWithStorageCleanup({
      fileId,
      userId: relation.package.userId,
      prisma: tx,
    });
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

// Package deletion cascades Release / PackageScreenshot rows and retires their
// files in one transaction. Prisma's 5 s default is too tight behind Hyperdrive.
const DEV_PACKAGE_DELETION_TRANSACTION = { maxWait: 5_000, timeout: 20_000 } as const;

export async function deleteDevPackage({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: packageId },
      select: {
        userId: true,
        iconFile: { select: { id: true, userId: true } },
        PackageScreenshot: {
          select: { file: { select: { id: true, userId: true } } },
        },
        Release: {
          select: { file: { select: { id: true, userId: true } } },
        },
      },
    });
    const ownedFileIds = new Set<string>();
    for (const file of [
      pkg.iconFile,
      ...pkg.PackageScreenshot.map((item) => item.file),
      ...pkg.Release.map((item) => item.file),
    ]) {
      if (file?.userId === pkg.userId) ownedFileIds.add(file.id);
    }
    await preparePackageDeletionOutboxes({ packageId, prisma: tx });
    const deleted = await tx.package.delete({ where: { id: packageId } });
    // One round trip per release or screenshot does not fit the interactive
    // transaction timeout once a package has accumulated a few dozen files.
    await deleteUnreferencedFilesWithStorageCleanup({
      fileIds: [...ownedFileIds],
      userId: pkg.userId,
      prisma: tx,
    });
    return deleted;
  };
  return prisma
    ? await run(prisma)
    : await startRetryableTransaction(run, DEV_PACKAGE_DELETION_TRANSACTION);
}

export async function upsertPackagePricings({
  packageId,
  pricings,
  prisma,
}: {
  packageId: string;
  pricings: { currency: string; price: number; fallback: boolean }[];
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    await tx.packagePricing.deleteMany({
      where: { packageId },
    });
    if (pricings.length > 0) {
      await tx.packagePricing.createMany({
        data: pricings.map((p) => ({
          packageId,
          currency: p.currency,
          price: p.price,
          fallback: p.fallback,
        })),
      });
    }
  };
  if (prisma) {
    await run(prisma);
  } else {
    const db = await getDb();
    await db.$transaction(run);
  }
}

export async function updatePackageInterval({
  packageId,
  interval,
  prisma,
}: {
  packageId: string;
  interval: PaymentInterval | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.update({
    where: { id: packageId },
    data: { interval },
    select: { name: true },
  });
}
