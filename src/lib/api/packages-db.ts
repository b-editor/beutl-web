import "server-only";
import { prisma } from "@/prisma";
import type { Prisma } from "@prisma/client";
import { packagePaied } from "@/lib/store-utils";
import { getContentUrl } from "@/lib/db/file";

export async function getPackage({
  userId,
  query,
  currency,
}: {
  userId?: string;
  query: Prisma.PackageWhereInput;
  currency?: string;
}) {
  const result = await prisma.package.findFirst({
    where: query,
    select: {
      id: true,
      published: true,
      userId: true,
      user: {
        select: {
          Profile: {
            select: {
              displayName: true,
              userName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      webSite: true,
      tags: true,
      iconFileId: true,
      PackageScreenshot: {
        select: {
          fileId: true,
        },
      },
      packagePricing: {
        where: {
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
        },
        select: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      UserPackage: userId
        ? {
          where: {
            userId: userId,
          },
          select: {
            packageId: true,
          },
          take: 1,
        }
        : undefined,
    },
  });

  return (
    result && {
      ...result,
      UserPackage: result.UserPackage as typeof result.UserPackage | undefined,
    }
  );
}

export async function getPackages({
  userId,
  query,
  currency,
}: {
  userId?: string;
  query: Prisma.PackageWhereInput;
  currency?: string;
}) {
  return prisma.package.findMany({
    where: query,
    select: {
      id: true,
      published: true,
      userId: true,
      user: {
        select: {
          Profile: {
            select: {
              displayName: true,
              userName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      webSite: true,
      tags: true,
      iconFileId: true,
      PackageScreenshot: {
        select: {
          fileId: true,
        },
      },
      packagePricing: {
        where: {
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
        },
        select: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      UserPackage: userId
        ? {
          where: {
            userId: userId,
          },
          select: {
            packageId: true,
          },
          take: 1,
        }
        : undefined,
    },
  });
}

export async function mapPackage({
  userId,
  currency,
  pkg,
}: {
  userId?: string;
  currency?: string;
  pkg: NonNullable<Awaited<ReturnType<typeof getPackage>>>;
}) {
  const owned = pkg.UserPackage && pkg.UserPackage.length > 0;
  let paied = false;
  if (userId) {
    paied = await packagePaied(pkg.id, userId);
  }

  const price =
    pkg.packagePricing.find((p) => p.currency === currency) ||
    pkg.packagePricing.find((p) => p.fallback) ||
    pkg.packagePricing[0];

  return {
    id: pkg.id,
    name: pkg.name,
    displayName: pkg.displayName,
    description: pkg.description,
    shortDescription: pkg.shortDescription,
    website: pkg.webSite,
    tags: pkg.tags,
    screenshots: await Promise.all(pkg.PackageScreenshot.map(async (i) => await getContentUrl(i.fileId))),
    logoId: pkg.iconFileId,
    logoUrl: await getContentUrl(pkg.iconFileId),
    currency: price?.currency || null,
    price: price?.price || null,
    owned: !!owned,
    paid: paied,
    owner: {
      id: pkg.userId,
      displayName: pkg.user.Profile?.displayName || "",
      name: pkg.user.Profile?.userName || "",
      bio: pkg.user.Profile?.bio || null,
      iconId: pkg.user.Profile?.iconFileId || null,
      iconUrl: await getContentUrl(pkg.user.Profile?.iconFileId),
    },
  };
}
