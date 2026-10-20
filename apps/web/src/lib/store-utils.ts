import "server-only";
import { unstable_cache } from "next/cache";
import { getDb, packageNameFilter } from "@beutl/db";
import { contentPath } from "@/lib/content-url";
import { withOwnPrismaClient } from "@/prisma";
import {
  localizedDisplayName,
  localizedPackageText,
  localizedReleaseDescription,
  localizedShortDescription,
  selectPricing,
  packageTypeWhere,
} from "@beutl/core";
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

export async function retrievePackage(name: string, lang: string) {
  const db = await getDb();
  const pkg = await db.package.findFirst({
    where: {
      name: packageNameFilter(name),
      published: true,
      audience: "USER",
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
      PackageTranslation: {
        where: { lang },
        select: {
          lang: true,
          displayName: true,
          shortDescription: true,
          description: true,
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
          ReleaseTranslation: {
            where: { lang },
            select: { lang: true, description: true },
          },
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

  const text = localizedPackageText(pkg, lang);
  // 翻訳行は表示用の文字列へ畳んだので、クライアントへは渡さない。
  const { PackageTranslation: _translations, ...rest } = pkg;

  return {
    ...rest,
    displayName: text.displayName,
    shortDescription: text.shortDescription,
    description: text.description,
    Release: pkg.Release.map(({ ReleaseTranslation, ...release }) => ({
      ...release,
      description: localizedReleaseDescription(
        { description: release.description, ReleaseTranslation },
        lang,
      ),
    })),
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

  Once stale, the entry is served as is and recomputed after the page has
  answered, so the query brings its own client rather than the request's,
  which closes with the response.
*/
const cachedLatestPublishedPackages = unstable_cache(
  (take: number, lang: string) =>
    withOwnPrismaClient((prisma) => retrieveLatestPublishedPackages({ take, lang, prisma })),
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
  lang: string,
): Promise<LandingPackage[]> {
  try {
    const packages = await cachedLatestPublishedPackages(take, lang);
    return packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      displayName: localizedDisplayName(pkg, lang) || pkg.name,
      shortDescription: localizedShortDescription(pkg, lang),
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
  query: string | undefined,
  type: PackageTypeFilter,
  lang: string,
): Promise<ListedPackage[]> {
  const db = await getDb();
  const currency = await guessCurrency();

  const tmp = await db.package.findMany({
    where: {
      published: true,
      audience: "USER" as const,
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
              // 表示言語に限らずどの翻訳に一致しても拾う。訳した説明文で
              // 探す利用者を取りこぼさない。
              {
                PackageTranslation: {
                  some: {
                    OR: [
                      { displayName: { contains: query } },
                      { shortDescription: { contains: query } },
                      { description: { contains: query } },
                    ],
                  },
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
      PackageTranslation: {
        where: { lang },
        select: {
          lang: true,
          displayName: true,
          shortDescription: true,
          description: true,
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

  return await Promise.all(
    tmp.map(async (pkg) => {
      const url = pkg.iconFileId && contentPath(pkg.iconFileId);

      return {
        id: pkg.id,
        name: pkg.name,
        displayName: localizedDisplayName(pkg, lang),
        shortDescription: localizedShortDescription(pkg, lang),
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
