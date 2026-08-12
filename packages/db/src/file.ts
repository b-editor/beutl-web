import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function findFileForContentAccess({
  id: fileId,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findFirst({
    where: {
      id: fileId,
    },
    select: {
      objectKey: true,
      visibility: true,
      userId: true,
      mimeType: true,
      Package: {
        select: {
          userId: true,
          published: true,
        },
      },
      Profile: true,
      PackageScreenshot: {
        select: {
          package: {
            select: {
              userId: true,
              published: true,
            },
          },
        },
      },
      Release: {
        select: {
          published: true,
          package: {
            select: {
              id: true,
              userId: true,
              published: true,
              packagePricing: {
                select: {
                  id: true,
                  price: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function findFileForApi({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
      name: true,
      mimeType: true,
      userId: true,
      visibility: true,
      size: true,
      sha256: true,
      Package: {
        select: {
          userId: true,
          published: true,
        },
      },
      Profile: {
        select: {
          userId: true,
        },
      },
      PackageScreenshot: {
        select: {
          package: {
            select: {
              userId: true,
              published: true,
            },
          },
        },
      },
      Release: {
        select: {
          published: true,
          packageSha256: true,
          approvedAnalyticsManifestSha256: true,
          package: {
            select: {
              id: true,
              userId: true,
              published: true,
              packagePricing: {
                select: {
                  id: true,
                  price: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function retrieveFilesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.file.findMany({
    where: {
      userId: userId,
    },
  });
}

export async function retrieveFilesByIdsAndUserId({
  ids,
  userId,
  prisma,
}: {
  ids: string[];
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      id: {
        in: ids,
      },
      userId,
    },
    select: {
      objectKey: true,
      id: true,
      visibility: true,
    },
  });
}

export async function updateFileVisibility({
  fileId,
  visibility,
  prisma,
}: {
  fileId: string;
  visibility: "PRIVATE" | "PUBLIC";
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.update({
    where: {
      id: fileId,
    },
    data: {
      visibility: visibility,
    },
  });
}

export async function retrieveFileNamesAndSizesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      userId,
    },
    select: {
      size: true,
      name: true,
    },
  });
}

export async function retrieveStorageFilesByUserId({
  userId,
  prisma,
}: {
  userId?: string;
  prisma?: PrismaTransaction;
}) {
  if (!userId) return [];
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      userId,
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
    },
  });
}
