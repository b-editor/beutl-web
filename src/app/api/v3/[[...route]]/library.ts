import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/db";
import { user, packageTable, packagePricing, release, userPackage } from "@/db/schema";
import { eq, and, gt, ilike } from "drizzle-orm";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { packageOwned, packagePaied } from "@/lib/store-utils";
import { guessCurrency } from "@/lib/currency";
import { SemVer } from "semver";
import { getContentUrl } from "@/lib/db/file";

const acquireSchema = z.object({
  packageId: z.string(),
});

async function createResponse(pkgId: string, userId: string | null) {
  const currency = await guessCurrency();
  const db = await getDbAsync();
  const pkg = await db.query.packageTable.findFirst({
    where: eq(packageTable.id, pkgId),
    columns: {
      published: true,
      id: true,
      name: true,
      displayName: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
    },
    with: {
      user: {
        with: {
          profile: {
            columns: {
              userName: true,
              displayName: true,
              bio: true,
              iconFileId: true,
            },
          },
        },
      },
      packagePricings: currency ? {
        where: (pp, { eq: e, or }) => or(
          ilike(pp.currency, currency),
          e(pp.fallback, true),
        ),
        columns: {
          price: true,
          currency: true,
          fallback: true,
        },
      } : {
        where: (pp, { eq: e }) => e(pp.fallback, true),
        columns: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      releases: {
        columns: {
          id: true,
          version: true,
        },
      },
    },
  });
  if (!pkg || !pkg.published) {
    return null;
  }
  const profileData = pkg.user.profile;
  pkg.releases.sort((a, b) => {
    return new SemVer(b.version).compare(a.version);
  });
  const latestReleaseId = pkg.releases?.[0]?.id;
  const latestRelease = latestReleaseId
    ? await db.query.release.findFirst({
      where: eq(release.id, latestReleaseId),
      columns: {
        id: true,
        version: true,
        title: true,
        description: true,
        targetVersion: true,
        fileId: true,
      },
    })
    : null;

  let paid = false;
  let owned = false;
  if (userId != null) {
    paid = await packagePaied(pkg.id, userId);
    owned = await packageOwned(pkg.id, userId);
  }

  const price =
    pkg.packagePricings.find((p) => p.currency === currency) ||
    pkg.packagePricings.find((p) => p.fallback) ||
    pkg.packagePricings[0];

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
        name: profileData?.userName || "",
        displayName: profileData?.displayName || "",
        bio: profileData?.bio || null,
        iconId: profileData?.iconFileId || null,
        iconUrl: await getContentUrl(profileData?.iconFileId),
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

    const db = await getDbAsync();
    const userResult = await db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        id: true,
      },
    });
    if (!userResult) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    const pkg = await createResponse(req.packageId, userId);
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }

    const paymentRequired = !!(await db.query.packagePricing.findFirst({
      where: and(
        eq(packagePricing.packageId, pkg.package.id),
        gt(packagePricing.price, 0),
      ),
      columns: {
        id: true,
      },
    }));
    if (paymentRequired) {
      const paied = await packagePaied(pkg.package.id, userResult.id);
      if (!paied) {
        return c.json(await apiErrorResponse("packageIsPrivate"), {
          status: 402,
        });
      }
    }

    const existingUserPackage = await db.query.userPackage.findFirst({
      where: and(
        eq(userPackage.userId, userResult.id),
        eq(userPackage.packageId, pkg.package.id),
      ),
    });
    if (!existingUserPackage) {
      await db.insert(userPackage).values({
        userId: userResult.id,
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

    const db = await getDbAsync();
    const packages = await db.query.userPackage.findMany({
      where: eq(userPackage.userId, userId),
      columns: {
        packageId: true,
      },
    });

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

    const db = await getDbAsync();
    // First find the package by name
    const pkg = await db.query.packageTable.findFirst({
      where: eq(packageTable.name, name),
      columns: {
        id: true,
      },
    });
    if (pkg) {
      await db.delete(userPackage)
        .where(and(
          eq(userPackage.userId, userId),
          eq(userPackage.packageId, pkg.id),
        ));
    }

    return c.text("Deleted");
  });

export default app;
