import "server-only";
import { getDbAsync } from "@/db";
import {
  packagePricing,
  userPackage,
} from "@/db/schema";
import { eq, ilike, or, type SQL } from "drizzle-orm";
import { packagePaied } from "@/lib/store-utils";
import { getContentUrl } from "@/lib/db/file";

export async function getPackage({
  userId,
  where,
  currency,
}: {
  userId?: string;
  where: SQL;
  currency?: string;
}) {
  const db = await getDbAsync();
  const result = await db.query.packageTable.findFirst({
    where,
    columns: {
      id: true,
      published: true,
      userId: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      webSite: true,
      tags: true,
      iconFileId: true,
    },
    with: {
      user: {
        columns: {},
        with: {
          profile: {
            columns: {
              displayName: true,
              userName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      packageScreenshots: {
        columns: { fileId: true },
      },
      packagePricings: {
        where: currency
          ? or(
              ilike(packagePricing.currency, currency),
              eq(packagePricing.fallback, true),
            )
          : undefined,
        columns: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      userPackages: userId
        ? {
            where: eq(userPackage.userId, userId),
            columns: { packageId: true },
            limit: 1,
          }
        : undefined,
    },
  });

  return result ?? null;
}

export async function getPackages({
  userId,
  where,
  currency,
}: {
  userId?: string;
  where: SQL;
  currency?: string;
}) {
  const db = await getDbAsync();
  return db.query.packageTable.findMany({
    where,
    columns: {
      id: true,
      published: true,
      userId: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      webSite: true,
      tags: true,
      iconFileId: true,
    },
    with: {
      user: {
        columns: {},
        with: {
          profile: {
            columns: {
              displayName: true,
              userName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      packageScreenshots: {
        columns: { fileId: true },
      },
      packagePricings: {
        where: currency
          ? or(
              ilike(packagePricing.currency, currency),
              eq(packagePricing.fallback, true),
            )
          : undefined,
        columns: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      userPackages: userId
        ? {
            where: eq(userPackage.userId, userId),
            columns: { packageId: true },
            limit: 1,
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
  const owned =
    "userPackages" in pkg &&
    pkg.userPackages &&
    pkg.userPackages.length > 0;
  let paied = false;
  if (userId) {
    paied = await packagePaied(pkg.id, userId);
  }

  const price =
    pkg.packagePricings.find((p) => p.currency === currency) ||
    pkg.packagePricings.find((p) => p.fallback) ||
    pkg.packagePricings[0];

  return {
    id: pkg.id,
    name: pkg.name,
    displayName: pkg.displayName,
    description: pkg.description,
    shortDescription: pkg.shortDescription,
    website: pkg.webSite,
    tags: pkg.tags,
    screenshots: await Promise.all(
      pkg.packageScreenshots.map(async (i) => await getContentUrl(i.fileId)),
    ),
    logoId: pkg.iconFileId,
    logoUrl: await getContentUrl(pkg.iconFileId),
    currency: price?.currency || null,
    price: price?.price || null,
    owned: !!owned,
    paid: paied,
    owner: {
      id: pkg.userId,
      displayName: pkg.user.profile?.displayName || "",
      name: pkg.user.profile?.userName || "",
      bio: pkg.user.profile?.bio || null,
      iconId: pkg.user.profile?.iconFileId || null,
      iconUrl: await getContentUrl(pkg.user.profile?.iconFileId),
    },
  };
}
