import "server-only";
import { drizzle } from "@/drizzle";
import { guessCurrency } from "./currency";
import { existsUserPaymentHistory } from "./db/user-payment-history";
import { and, arrayOverlaps, count, desc, eq, ilike, or } from "drizzle-orm";
import { file, packagePricing, packages, packageScreenshot, profile, release, userPackage } from "@/drizzle/schema";

export async function packageOwned(pkgId: string, userId: string) {
  const db = await drizzle();
  return await db.select({ cnt: count() })
    .from(userPackage)
    .where(and(
      eq(userPackage.userId, userId),
      eq(userPackage.packageId, pkgId),
    ))
    .then((rows) => rows[0].cnt > 0);
}

export async function packagePaied(pkgId: string, userId: string) {
  return existsUserPaymentHistory({ userId, packageId: pkgId });
}

export async function retrievePrices(pkgId: string) {
  const db = await drizzle();
  return await db.select({
    currency: packagePricing.currency,
    price: packagePricing.price,
    fallback: packagePricing.fallback,
  }).from(packagePricing)
    .where(eq(packagePricing.packageId, pkgId));
}

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;

export async function retrievePackage(name: string) {
  const db = await drizzle();

  const pkg = await db.select({
    id: packages.id,
    name: packages.name,
    displayName: packages.displayName,
    description: packages.description,
    shortDescription: packages.shortDescription,
    published: packages.published,
    webSite: packages.webSite,
    tags: packages.tags,
    iconFileId: packages.iconFileId,
    userProfile: {
      userName: profile.userName,
    }
  })
    .from(packages)
    .innerJoin(profile, eq(packages.userId, profile.userId))
    .where(and(
      ilike(packages.name, name),
      eq(packages.published, true),
    ))
    .limit(1)
    .then((rows) => rows.at(0));
  if (!pkg) {
    return null;
  }
  const screenshotsPromise = db.select({
    order: packageScreenshot.order,
    fileId: packageScreenshot.fileId,
    objectKey: file.objectKey,
  })
    .from(packageScreenshot)
    .innerJoin(file, eq(packageScreenshot.fileId, file.id))
    .where(eq(packageScreenshot.packageId, pkg.id))
    .orderBy(packageScreenshot.order)
    .execute()
    .then((rows) => rows.map((item) => ({
      ...item,
      url: `/api/contents/${item.fileId}`,
    })));

  const releasePromise = db.select({
    version: release.version,
    title: release.title,
    description: release.description,
    targetVersion: release.targetVersion,
    id: release.id,
  })
    .from(release)
    .where(and(
      eq(release.packageId, pkg.id),
      eq(release.published, true),
    ))
    .execute();

  const [screenshotRows, releaseRows] = await Promise.all([screenshotsPromise, releasePromise]);

  return {
    ...pkg,
    iconFileUrl: pkg.iconFileId && `/api/contents/${pkg.iconFileId}`,
    screenshots: screenshotRows,
    releases: releaseRows
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
  const currency = await guessCurrency();
  const db = await drizzle();

  const b = () => db.select({
    id: packages.id,
    displayName: packages.displayName,
    name: packages.name,
    shortDescription: packages.shortDescription,
    tags: packages.tags,
    iconFileId: packages.iconFileId,
    userId: packages.userId,
    userProfile: {
      userName: profile.userName,
    }
  })
    .from(packages)
    .innerJoin(profile, eq(packages.userId, profile.userId))
    .orderBy(desc(packages.createdAt));

  const tmp = await (query ? b().where(and(
    eq(packages.published, true),
    or(
      ilike(packages.name, `%${query}%`),
      ilike(packages.displayName, `%${query}%`),
      ilike(packages.description, `%${query}%`),
      ilike(packages.shortDescription, `%${query}%`),
      // タグにクエリが含まれているか
      arrayOverlaps(packages.tags, [query]),
    ),
  )) : b().where(
    eq(packages.published, true)
  ));

  return await Promise.all(tmp.map(async (pkg) => {
    const pricings = await db.select({
      price: packagePricing.price,
      currency: packagePricing.currency,
      fallback: packagePricing.fallback,
    })
      .from(packagePricing)
      .where(
        and(
          or(
            ilike(packagePricing.currency, currency),
            eq(packagePricing.fallback, true),
          )),
      );

    const url = pkg.iconFileId && `/api/contents/${pkg.iconFileId}`;

    const price = pricings.find((p) => p.currency === currency) ||
      pricings.find((p) => p.fallback) ||
      pricings?.[0] ||
      null;

    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      shortDescription: pkg.shortDescription,
      userName: pkg.userProfile?.userName || null,
      userId: pkg.userId,
      iconFileUrl: url,
      iconFileId: pkg.iconFileId,
      tags: pkg.tags || [],
      price: price ? {
        price: price.price,
        currency: price.currency,
      } : null,
    };
  }));
}
