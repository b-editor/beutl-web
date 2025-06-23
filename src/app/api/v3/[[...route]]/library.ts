import "server-only";
import { Hono } from "hono";
import { drizzle } from "@/drizzle";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { packageOwned, packagePaied } from "@/lib/store-utils";
import { guessCurrency } from "@/lib/currency";
import { SemVer } from "semver";
import { getContentUrl } from "@/lib/db/file";
import { packagePricing, packages, profile, release, userPackage } from "@/drizzle/schema";
import { eq, ilike, and, or, count, gt } from "drizzle-orm";

const acquireSchema = z.object({
  packageId: z.string(),
});

async function createResponse(pkgId: string, userId: string | null) {
  const currency = await guessCurrency();
  const db = await drizzle();
  const pkg = await db.select({
    id: packages.id,
    published: packages.published,
    name: packages.name,
    displayName: packages.displayName,
    shortDescription: packages.shortDescription,
    tags: packages.tags,
    iconFileId: packages.iconFileId,
    userId: packages.userId,
    userProfile: {
      userName: profile.userName,
      displayName: profile.displayName,
      bio: profile.bio,
      iconFileId: profile.iconFileId,
    }
  })
    .from(packages)
    .innerJoin(profile, eq(packages.userId, profile.userId))
    .where(eq(packages.id, pkgId))
    .limit(1)
    .then((rows) => rows.at(0));
  const pricings = await db.select({
    price: packagePricing.price,
    currency: packagePricing.currency,
    fallback: packagePricing.fallback,
  })
    .from(packagePricing)
    .where(
      and(
        eq(packagePricing.packageId, pkgId),
        or(
          ilike(packagePricing.currency, currency),
          eq(packagePricing.fallback, true),
        ),
      ),
    );
  const releases = await db.select({
    id: release.id,
    version: release.version,
    title: release.title,
    description: release.description,
    targetVersion: release.targetVersion,
    fileId: release.fileId,
  })
    .from(release)
    .where(eq(release.packageId, pkgId));
  if (!pkg || !pkg.published) {
    return null;
  }
  releases.sort((a, b) => {
    return new SemVer(b.version).compare(a.version);
  });
  const latestRelease = releases.at(0) || null;

  let paid = false;
  let owned = false;
  if (userId != null) {
    paid = await packagePaied(pkg.id, userId);
    owned = await packageOwned(pkg.id, userId);
  }

  const price =
    pricings.find((p) => p.currency === currency) ||
    pricings.find((p) => p.fallback) ||
    pricings[0];

  return {
    package: {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      shortDescription: pkg.shortDescription,
      tags: pkg.tags,
      logoId: pkg.iconFileId,
      logoUrl: await getContentUrl(pkg.iconFileId),
      currency: price?.currency || null,
      price: price?.price || null,
      paid: paid,
      owned: owned,
      owner: {
        id: pkg.userId,
        name: pkg.userProfile?.userName || "",
        displayName: pkg.userProfile?.displayName || "",
        bio: pkg.userProfile?.bio || null,
        iconId: pkg.userProfile?.iconFileId || null,
        iconUrl: await getContentUrl(pkg.userProfile?.iconFileId),
      },
    },
    latestRelease: latestRelease
      ? {
        id: latestRelease.id,
        version: latestRelease.version,
        title: latestRelease.title,
        description: latestRelease.description,
        targetVersion: latestRelease.targetVersion,
        fileId: latestRelease.fileId,
        fileUrl: await getContentUrl(latestRelease.fileId),
      }
      : null,
  };
}

const app = new Hono()
  .post("/", zValidator("json", acquireSchema), async (c) => {
    const req = c.req.valid("json");
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const db = await drizzle();
    const userExists = await db.select({ cnt: count() })
      .from(profile)
      .where(eq(profile.userId, userId))
      .then((rows) => (rows.at(0)?.cnt || 0) > 0);
    if (!userExists) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    const pkg = await createResponse(req.packageId, userId);
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    const paymentRequired = !!await db
      .select({ id: packagePricing.id })
      .from(packagePricing)
      .where(
        and(eq(packagePricing.packageId, pkg.package.id), gt(packagePricing.price, 0)),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    if (paymentRequired) {
      const paied = await packagePaied(pkg.package.id, userId);
      if (!paied) {
        return c.json(await apiErrorResponse("packageIsPrivate"), {
          status: 402,
        });
      }
    }
    const existing = await db
      .select()
      .from(userPackage)
      .where(
        and(
          eq(userPackage.userId, userId),
          eq(userPackage.packageId, pkg.package.id),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    if (!existing) {
      await db.insert(userPackage).values({
        userId: userId,
        packageId: pkg.package.id,
      });
    }

    return c.json(pkg);
  })
  .get("/", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const db = await drizzle();
    const packages = await db
      .select({
        packageId: userPackage.packageId,
      })
      .from(userPackage)
      .where(eq(userPackage.userId, userId));

    return c.json(
      await Promise.all(
        packages.map(
          async (pkg) => await createResponse(pkg.packageId, userId),
        ),
      ),
    );
  })
  .delete("/:name", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const db = await drizzle();
    const targetPkg = await db.select({ id: packages.id })
      .from(packages)
      .where(eq(packages.name, name))
      .limit(1)
      .then(rows => rows.at(0));

    if (targetPkg) {
      await db.delete(userPackage)
        .where(
          and(
            eq(userPackage.userId, userId),
            eq(userPackage.packageId, targetPkg.id),
          ),
        );
    }

    return c.text("Deleted");
  });

export default app;
