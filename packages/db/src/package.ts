import { getDb } from "./provider";
import type { PaymentInterval } from "@prisma/client";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import {
  claimPendingStorageFileReference,
  enqueueFileCleanupIfUnreferenced,
} from "./storage-cleanup";

export class PackageFileConflictError extends Error {
  constructor() {
    super("The package file reference changed concurrently.");
    this.name = "PackageFileConflictError";
  }
}

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

export async function findPackageForBillingHistory({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.package.findFirst({
    where: {
      id: packageId,
    },
    select: {
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
  expectedFileId,
  prisma,
}: {
  packageId: string;
  fileId: string;
  expectedFileId: string | null;
  prisma?: PrismaTransaction;
}) {
  const replace = async (tx: PrismaTransaction) => {
    const changed = await tx.package.updateMany({
      where: { id: packageId, iconFileId: expectedFileId },
      data: { iconFileId: fileId },
    });
    if (changed.count !== 1) throw new PackageFileConflictError();
    await claimPendingStorageFileReference({ fileId, prisma: tx });
    if (expectedFileId) {
      await enqueueFileCleanupIfUnreferenced({
        fileId: expectedFileId,
        prisma: tx,
      });
    }
    return await tx.package.findUniqueOrThrow({
      where: { id: packageId },
      select: { name: true },
    });
  };
  return prisma
    ? await replace(prisma)
    : await startRetryableTransaction(replace);
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
  const create = async (tx: PrismaTransaction) => {
    const screenshot = await tx.packageScreenshot.create({
      data: { packageId, fileId, order },
    });
    await claimPendingStorageFileReference({ fileId, prisma: tx });
    return screenshot;
  };
  return prisma
    ? await create(prisma)
    : await startRetryableTransaction(create);
}

export async function updateDevPackageScreenshotOrder({
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
  return await db.packageScreenshot.update({
    where: {
      packageId_fileId: {
        packageId: packageId,
        fileId: fileId,
      },
    },
    data: {
      order: order,
    },
  });
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
  const remove = async (tx: PrismaTransaction) => {
    const screenshot = await tx.packageScreenshot.delete({
      where: { packageId_fileId: { packageId, fileId } },
    });
    await enqueueFileCleanupIfUnreferenced({ fileId, prisma: tx });
    return screenshot;
  };
  return prisma
    ? await remove(prisma)
    : await startRetryableTransaction(remove);
}

export async function deleteDevPackage({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const remove = async (tx: PrismaTransaction) => {
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: packageId },
      select: {
        iconFileId: true,
        PackageScreenshot: { select: { fileId: true } },
        Release: { select: { fileId: true } },
      },
    });
    const deleted = await tx.package.delete({ where: { id: packageId } });
    const fileIds = new Set<string>();
    if (pkg.iconFileId) fileIds.add(pkg.iconFileId);
    for (const item of pkg.PackageScreenshot) fileIds.add(item.fileId);
    for (const item of pkg.Release) {
      if (item.fileId) fileIds.add(item.fileId);
    }
    for (const fileId of fileIds) {
      await enqueueFileCleanupIfUnreferenced({ fileId, prisma: tx });
    }
    return deleted;
  };
  return prisma
    ? await remove(prisma)
    : await startRetryableTransaction(remove);
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
