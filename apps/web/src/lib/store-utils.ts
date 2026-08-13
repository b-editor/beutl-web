import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@beutl/db";
import { contentPath } from "@/lib/content-url";
import { selectPricing, packageTypeWhere } from "@beutl/core";
import type { PackageTypeFilter } from "@beutl/core";
import { guessCurrency } from "./currency";
import {
  existsUserPaymentHistory,
  retrieveLatestPublishedPackages,
} from "@beutl/db";

export async function packageOwned(pkgId: string, userId: string) {
  const db = await getDb();
  return !!(await db.userPackage.findFirst({
    where: {
      userId: userId,
      packageId: pkgId,
    },
  }));
}

export async function packagePaied(pkgId: string, userId: string) {
  return existsUserPaymentHistory({ userId, packageId: pkgId });
}

export async function retrievePrices(pkgId: string) {
  const db = await getDb();
  return await db.packagePricing.findMany({
    where: {
      packageId: pkgId,
    },
    select: {
      currency: true,
      price: true,
      fallback: true,
    },
  });
}

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;

export async function retrievePackage(name: string) {
  const db = await getDb();
  const pkg = await db.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
      published: true,
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
        },
        where: {
          published: true,
        },
      },
    },
  });
  if (!pkg) {
    return null;
  }

  const screenshots = await Promise.all(
    pkg.PackageScreenshot.map(async (item) => {
      return {
        ...item,
        url: contentPath(item.file.id),
      };
    }),
  );

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && contentPath(pkg.iconFile.id),
    PackageScreenshot: screenshots,
  };
}

export type LandingPackage = {
  id: string;
  name: string;
  displayName: string;
  shortDescription: string;
  publisherName: string | null;
  iconFileUrl: string | null;
};

/*
  The landing page route is dynamic, so without this every visit to the front
  door would open a database connection for a list that changes on the order of
  weeks. The cache wraps the query alone: an error must not be cached, or one
  blip would blank the section for the whole revalidation window.
*/
const cachedLatestPublishedPackages = unstable_cache(
  (take: number) => retrieveLatestPublishedPackages({ take }),
  ["landing-latest-packages"],
  { revalidate: 3600 },
);

/*
  Unlike the store listing this deliberately swallows its own failure: the
  landing page is the front door and has to render even when the store database
  is unreachable, so a lost connection costs two cards rather than the page.
  Pricing is left out for the same reason — it would pull in guessCurrency and
  its ipinfo lookup.
*/
export async function retrieveLatestPackagesForLanding(
  take: number,
): Promise<LandingPackage[]> {
  try {
    const packages = await cachedLatestPublishedPackages(take);
    return packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || pkg.name,
      shortDescription: pkg.shortDescription,
      publisherName:
        pkg.user.Profile?.displayName || pkg.user.Profile?.userName || null,
      iconFileUrl: pkg.iconFileId ? contentPath(pkg.iconFileId) : null,
    }));
  } catch (error) {
    console.error(
      "[landing] could not load the store packages; rendering without them:",
      error,
    );
    return [];
  }
}

export type ListedPackage = {
  id: string;
  name: string;
  displayName: string | null;
  shortDescription: string;
  userName: string | null;
  userId: string;
  iconFileUrl: string | null;
  iconFileId: string | null;
  tags: string[];
  price: {
    price: number;
    currency: string;
  } | null;
};

export async function retrievePackages(
  query?: string,
  type?: PackageTypeFilter,
): Promise<ListedPackage[]> {
  const db = await getDb();
  const currency = await guessCurrency();

  const tmp = await db.package.findMany({
    where: {
      published: true,
      ...packageTypeWhere(type),
      ...(query
        ? {
            OR: [
              {
                name: {
                  contains: query,
                },
              },
              {
                displayName: {
                  contains: query,
                },
              },
              {
                description: {
                  contains: query,
                },
              },
              {
                shortDescription: {
                  contains: query,
                },
              },
              {
                tags: {
                  hasSome: [query],
                },
              },
            ],
          }
        : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      displayName: true,
      name: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
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

  return await Promise.all(
    tmp.map(async (pkg) => {
      const url = pkg.iconFileId && contentPath(pkg.iconFileId);

      return {
        id: pkg.id,
        name: pkg.name,
        displayName: pkg.displayName,
        shortDescription: pkg.shortDescription,
        userName: pkg.user.Profile?.userName || null,
        userId: pkg.userId,
        iconFileUrl: url,
        iconFileId: pkg.iconFileId,
        tags: pkg.tags,
        price: selectPricing(pkg.packagePricing, currency) || null,
      };
    }),
  );
}
