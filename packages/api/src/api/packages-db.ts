import { getDb } from "@beutl/db";
import type { Prisma } from "@prisma/client";
import { packagePaied } from "../store-utils";
import { getContentUrl } from "../content-url";
import { localizedPackageText, selectPricing } from "@beutl/core";
import { packageTranslationSelect } from "@beutl/db";

export async function getPackage({
  userId,
  query,
  currency,
  lang,
}: {
  userId?: string;
  query: Prisma.PackageWhereInput;
  currency?: string;
  lang?: string;
}) {
  const db = await getDb();
  const result = await db.package.findFirst({
    where: { AND: [query, { audience: "USER" }] },
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
      ...(lang ? packageTranslationSelect(lang) : {}),
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
  lang,
}: {
  userId?: string;
  query: Prisma.PackageWhereInput;
  currency?: string;
  lang?: string;
}) {
  const db = await getDb();
  return db.package.findMany({
    where: { AND: [query, { audience: "USER" }] },
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
      ...(lang ? packageTranslationSelect(lang) : {}),
    },
  });
}

export async function mapPackage({
  userId,
  currency,
  pkg,
  request,
  lang,
}: {
  userId?: string;
  currency?: string;
  pkg: NonNullable<Awaited<ReturnType<typeof getPackage>>>;
  request?: Request;
  lang?: string;
}) {
  const owned = pkg.UserPackage && pkg.UserPackage.length > 0;
  let paied = false;
  if (userId) {
    paied = await packagePaied(pkg.id, userId);
  }

  const price = selectPricing(pkg.packagePricing, currency);
  const texts = localizedPackageText(pkg, lang ?? "");

  return {
    id: pkg.id,
    name: pkg.name,
    displayName: texts.displayName,
    description: texts.description,
    shortDescription: texts.shortDescription,
    website: pkg.webSite,
    tags: pkg.tags,
    screenshots: await Promise.all(pkg.PackageScreenshot.map(async (i) => await getContentUrl(i.fileId, request))),
    logoId: pkg.iconFileId,
    logoUrl: await getContentUrl(pkg.iconFileId, request),
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
      iconUrl: await getContentUrl(pkg.user.Profile?.iconFileId, request),
    },
  };
}
