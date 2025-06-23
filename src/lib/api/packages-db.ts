import "server-only";
import { drizzle } from "@/drizzle";
import { packagePaied } from "@/lib/store-utils";
import { getContentUrl } from "@/lib/db/file";
import { packagePricing, packages, packageScreenshot, profile, userPackage } from "@/drizzle/schema";
import { ilike, eq, or, and, count } from "drizzle-orm";

export async function getPackage({
  userId,
  name,
  currency,
}: {
  userId?: string;
  name: string;
  currency?: string;
}) {
  const db = await drizzle();
  const row = await db.select({
    id: packages.id,
    published: packages.published,
    userId: packages.userId,
    name: packages.name,
    displayName: packages.displayName,
    description: packages.description,
    shortDescription: packages.shortDescription,
    webSite: packages.webSite,
    tags: packages.tags,
    iconFileId: packages.iconFileId,
    userProfile: {
      displayName: profile.displayName,
      userName: profile.userName,
      bio: profile.bio,
      iconFileId: profile.iconFileId,
    }
  })
    .from(packages)
    .innerJoin(profile, eq(packages.userId, profile.userId))
    .where(ilike(packages.name, name))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!row) return null;

  const screenshotsPromise = db.select({
    fileId: packageScreenshot.fileId,
  })
    .from(packageScreenshot)
    .where(eq(packageScreenshot.packageId, row.id))
    .execute();

  const pricingsPromise = db.select({
    price: packagePricing.price,
    currency: packagePricing.currency,
    fallback: packagePricing.fallback,
  })
    .from(packagePricing)
    .where(and(
      eq(packagePricing.packageId, row.id),
      or(
        ilike(packagePricing.currency, currency || ""),
        eq(packagePricing.fallback, true)
      )
    ))
    .execute();

  const userPackagePromise = userId
    ? db.select({
      cnt: count()
    })
      .from(userPackage)
      .where(and(
        eq(userPackage.userId, userId),
        eq(userPackage.packageId, row.id)
      ))
      .limit(1)
      .execute()
      .then(rows => rows[0]?.cnt > 0)
    : Promise.resolve(false);

  const [screenshotRows, pricingRows, owned] = await Promise.all([
    screenshotsPromise,
    pricingsPromise,
    userPackagePromise,
  ]);

  return {
    ...row,
    screenshots: screenshotRows,
    packagePricing: pricingRows,
    owned,
  }
}

export async function getPackages({
  userId,
  ownerId,
  published,
  currency,
}: {
  ownerId: string;
  published: boolean;
  userId?: string;
  currency?: string;
}) {
  const db = await drizzle();
  const rows = await db.select({
    id: packages.id,
    published: packages.published,
    userId: packages.userId,
    name: packages.name,
    displayName: packages.displayName,
    description: packages.description,
    shortDescription: packages.shortDescription,
    webSite: packages.webSite,
    tags: packages.tags,
    iconFileId: packages.iconFileId,
    userProfile: {
      displayName: profile.displayName,
      userName: profile.userName,
      bio: profile.bio,
      iconFileId: profile.iconFileId,
    }
  })
    .from(packages)
    .innerJoin(profile, eq(packages.userId, profile.userId))
    .where(and(
      eq(packages.userId, ownerId),
      eq(packages.published, published)
    ));


  return await Promise.all(rows.map(async (row) => {
    const screenshotsPromise = db.select({
      fileId: packageScreenshot.fileId,
    })
      .from(packageScreenshot)
      .where(eq(packageScreenshot.packageId, row.id))
      .execute();

    const pricingsPromise = db.select({
      price: packagePricing.price,
      currency: packagePricing.currency,
      fallback: packagePricing.fallback,
    })
      .from(packagePricing)
      .where(and(
        eq(packagePricing.packageId, row.id),
        or(
          ilike(packagePricing.currency, currency || ""),
          eq(packagePricing.fallback, true)
        )
      ))
      .execute();

    const userPackagePromise = userId
      ? db.select({
        cnt: count()
      })
        .from(userPackage)
        .where(and(
          eq(userPackage.userId, userId),
          eq(userPackage.packageId, row.id)
        ))
        .limit(1)
        .execute()
        .then(rows => rows[0]?.cnt > 0)
      : Promise.resolve(false);

    const [screenshotRows, pricingRows, owned] = await Promise.all([
      screenshotsPromise,
      pricingsPromise,
      userPackagePromise,
    ]);

    return {
      ...row,
      screenshots: screenshotRows,
      packagePricing: pricingRows,
      owned,
    }
  }));
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
  const owned = pkg.owned;
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
    screenshots: await Promise.all(pkg.screenshots.map(async (i) => await getContentUrl(i.fileId))),
    logoId: pkg.iconFileId,
    logoUrl: await getContentUrl(pkg.iconFileId),
    currency: price?.currency || null,
    price: price?.price || null,
    owned: !!owned,
    paid: paied,
    owner: {
      id: pkg.userId,
      displayName: pkg.userProfile?.displayName || "",
      name: pkg.userProfile?.userName || "",
      bio: pkg.userProfile?.bio || null,
      iconId: pkg.userProfile?.iconFileId || null,
      iconUrl: await getContentUrl(pkg.userProfile?.iconFileId),
    },
  };
}
