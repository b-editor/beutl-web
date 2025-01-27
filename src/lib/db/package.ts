import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function retrieveDevPackagesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || sharedPrisma).package.findMany({
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

export async function retrieveDevPackageByName({
  name,
  userId,
  prisma,
}: {
  name: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || sharedPrisma).package.findFirst({
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
  return await (prisma || sharedPrisma).package.count({
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
  return await (prisma || sharedPrisma).package.create({
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
  return (
    await (prisma || sharedPrisma).package.findFirst({
      where: {
        id: packageId,
      },
      select: {
        userId: true,
      },
    })
  )?.userId;
}

export async function getPackageNameFromPackageId({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  return (
    await (prisma || sharedPrisma).package.findFirst({
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
  return await (prisma || sharedPrisma).package.update({
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
  return await (prisma || sharedPrisma).package.update({
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
  return await (prisma || sharedPrisma).package.update({
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
  return await (prisma || sharedPrisma).package.update({
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

export async function retrieveDevPackageDependsFile({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const pkg = await (prisma || sharedPrisma).package.findFirstOrThrow({
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
  return (
    await (prisma || sharedPrisma).package.findFirst({
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
  return await (prisma || sharedPrisma).packageScreenshot.findMany({
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
  return await (prisma || sharedPrisma).packageScreenshot.findFirst({
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
  return await (prisma || sharedPrisma).packageScreenshot.create({
    data: {
      packageId: packageId,
      fileId: fileId,
      order: order,
    },
  });
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
  return await (prisma || sharedPrisma).packageScreenshot.update({
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
  return await (prisma || sharedPrisma).package.update({
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
  return await (prisma || sharedPrisma).packageScreenshot.delete({
    where: {
      packageId_fileId: {
        packageId: packageId,
        fileId: fileId,
      },
    },
  });
}

export async function deleteDevPackage({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || sharedPrisma).package.delete({
    where: {
      id: packageId,
    },
  });
}
