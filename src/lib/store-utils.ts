import "server-only";
import { getDbAsync } from "@/db";
import {
  packageTable,
  packagePricing,
  packageScreenshot,
  userPackage,
} from "@/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  like,
  or,
  sql,
} from "drizzle-orm";
import { guessCurrency } from "./currency";
import { existsUserPaymentHistory } from "./db/user-payment-history";

export async function packageOwned(pkgId: string, userId: string) {
  const db = await getDbAsync();
  const result = await db
    .select({ userId: userPackage.userId })
    .from(userPackage)
    .where(
      and(eq(userPackage.userId, userId), eq(userPackage.packageId, pkgId)),
    )
    .limit(1);
  return result.length > 0;
}

export async function packagePaied(pkgId: string, userId: string) {
  return existsUserPaymentHistory({ userId, packageId: pkgId });
}

export async function retrievePrices(pkgId: string) {
  const db = await getDbAsync();
  return await db
    .select({
      currency: packagePricing.currency,
      price: packagePricing.price,
      fallback: packagePricing.fallback,
    })
    .from(packagePricing)
    .where(eq(packagePricing.packageId, pkgId));
}

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;

export async function retrievePackage(name: string) {
  const db = await getDbAsync();
  const pkg = await db.query.packageTable.findFirst({
    where: and(ilike(packageTable.name, name), eq(packageTable.published, true)),
    columns: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
    },
    with: {
      user: {
        columns: {},
        with: {
          profile: {
            columns: { userName: true },
          },
        },
      },
      iconFile: {
        columns: { id: true, objectKey: true },
      },
      packageScreenshots: {
        columns: { order: true },
        with: {
          file: {
            columns: { id: true, objectKey: true },
          },
        },
        orderBy: asc(packageScreenshot.order),
      },
      releases: {
        columns: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
        },
        where: (release, { eq }) => eq(release.published, true),
      },
    },
  });
  if (!pkg) {
    return null;
  }

  const screenshots = pkg.packageScreenshots.map((item) => ({
    ...item,
    url: `/api/contents/${item.file.id}`,
  }));

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}`,
    packageScreenshots: screenshots,
  };
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
): Promise<ListedPackage[]> {
  const db = await getDbAsync();
  const currency = await guessCurrency();

  const baseWhere = query
    ? and(
        eq(packageTable.published, true),
        or(
          like(packageTable.name, `%${query}%`),
          like(packageTable.displayName, `%${query}%`),
          like(packageTable.description, `%${query}%`),
          like(packageTable.shortDescription, `%${query}%`),
          sql`${packageTable.tags} && ARRAY[${query}]::text[]`,
        ),
      )
    : eq(packageTable.published, true);

  const tmp = await db.query.packageTable.findMany({
    where: baseWhere,
    orderBy: desc(packageTable.createdAt),
    columns: {
      id: true,
      displayName: true,
      name: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
    },
    with: {
      user: {
        columns: {},
        with: {
          profile: {
            columns: { userName: true },
          },
        },
      },
      packagePricings: {
        where: currency
          ? or(ilike(packagePricing.currency, currency), eq(packagePricing.fallback, true))
          : eq(packagePricing.fallback, true),
        columns: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
    },
  });

  return tmp.map((pkg) => {
    const url = pkg.iconFileId && `/api/contents/${pkg.iconFileId}`;
    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      shortDescription: pkg.shortDescription,
      userName: pkg.user.profile?.userName || null,
      userId: pkg.userId,
      iconFileUrl: url,
      iconFileId: pkg.iconFileId,
      tags: pkg.tags ?? [],
      price:
        pkg.packagePricings.find(
          (p) => p.currency.toLowerCase() === currency?.toLowerCase(),
        ) ||
        pkg.packagePricings.find((p) => p.fallback) ||
        pkg.packagePricings[0] ||
        null,
    };
  });
}
