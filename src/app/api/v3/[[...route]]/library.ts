import "server-only";
import { Hono } from "hono";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { packageOwned, packagePaied } from "@/lib/store-utils";
import { guessCurrency } from "@/lib/currency";
import { SemVer } from "semver";
import { getContentUrl } from "@/lib/content-url";
import { selectPricing } from "@/lib/pricing";
import {
  existsPaidPricingForPackage,
  findPackageForLibraryResponse,
} from "@/lib/db/package";
import { findReleaseForLibrary } from "@/lib/db/release";
import { findUserForLibrary } from "@/lib/db/user";
import {
  createUserPackage,
  deleteUserPackagesByUserAndPackageName,
  existsUserPackage,
  findUserPackageIdsByUserId,
} from "@/lib/db/user-package";

const acquireSchema = z.object({
  packageId: z.string(),
});

async function createResponse(pkgId: string, userId: string | null) {
  const currency = await guessCurrency();
  const pkg = await findPackageForLibraryResponse({
    id: pkgId,
    currency,
  });
  if (!pkg || !pkg.published) {
    return null;
  }
  const profile = pkg.user.Profile;
  pkg.Release.sort((a, b) => {
    return new SemVer(b.version).compare(a.version);
  });
  const latestReleaseId = pkg.Release?.[0]?.id;
  const latestRelease = latestReleaseId
    ? await findReleaseForLibrary({
      id: latestReleaseId,
    })
    : null;

  let paid = false;
  let owned = false;
  if (userId != null) {
    paid = await packagePaied(pkg.id, userId);
    owned = await packageOwned(pkg.id, userId);
  }

  const price = selectPricing(pkg.packagePricing, currency);

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
        name: profile?.userName || "",
        displayName: profile?.displayName || "",
        bio: profile?.bio || null,
        iconId: profile?.iconFileId || null,
        iconUrl: await getContentUrl(profile?.iconFileId),
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

    const user = await findUserForLibrary({
      id: userId,
    });
    if (!user) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    const pkg = await createResponse(req.packageId, userId);
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }

    const paymentRequired = !!(await existsPaidPricingForPackage({
      packageId: pkg.package.id,
    }));
    if (paymentRequired) {
      const paied = await packagePaied(pkg.package.id, user.id);
      if (!paied) {
        return c.json(await apiErrorResponse("packageIsPrivate"), {
          status: 402,
        });
      }
    }

    if (
      !(await existsUserPackage({
        userId: user.id,
        packageId: pkg.package.id,
      }))
    ) {
      await createUserPackage({
        userId: user.id,
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

    const packages = await findUserPackageIdsByUserId({
      userId: userId,
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

    await deleteUserPackagesByUserAndPackageName({
      userId: userId,
      name: name,
    });

    return c.text("Deleted");
  });

export default app;
