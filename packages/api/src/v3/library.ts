import { nugetFileUrl } from "../nuget/tickets";
import { Hono } from "hono";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ownedPackageIds, packagePaied, paidPackageIds } from "../store-utils";
import { guessCurrency } from "../currency";
import { compareNugetVersions, localizedDisplayName, localizedReleaseDescription, localizedShortDescription } from "@beutl/core";
import { getContentUrl } from "../content-url";
import { selectPricing } from "@beutl/core";
import { getLanguage } from "../lang-utils";
import {
  existsPaidPricingForPackage,
  findPackagesForLibraryResponse,
} from "@beutl/db";
import { findReleasesForLibrary } from "@beutl/db";
import { findUserForLibrary } from "@beutl/db";
import {
  createUserPackage,
  deleteUserPackagesByUserAndPackageName,
  existsUserPackage,
  findUserPackageIdsByUserId,
} from "@beutl/db";

const acquireSchema = z.object({
  packageId: z.string(),
  // 省略時は Accept-Language から解決する。古いクライアントは送らない。
  lang: z.string().optional(),
});

// The queries cover every package at once, so a larger library adds no database round trips.
// Unpublished and missing packages are left out; the rest keep the order of pkgIds.
async function createResponses(
  pkgIds: string[],
  userId: string | null,
  request?: Request,
  lang?: string,
) {
  const currency = await guessCurrency(request);
  const displayLang = lang ?? await getLanguage(request);
  const found = await findPackagesForLibraryResponse({
    ids: pkgIds,
    currency,
    lang: displayLang,
  });
  const publishedById = new Map(found.filter((pkg) => pkg.published).map((pkg) => [pkg.id, pkg]));
  const packages = pkgIds.flatMap((id) => publishedById.get(id) ?? []);
  const latestReleaseIds = new Map<string, string>();
  for (const pkg of packages) {
    pkg.Release.sort((a, b) => {
      return compareNugetVersions(b.version, a.version);
    });
    const latestReleaseId = pkg.Release?.[0]?.id;
    if (latestReleaseId) latestReleaseIds.set(pkg.id, latestReleaseId);
  }

  const ids = packages.map((pkg) => pkg.id);
  const [releases, paid, owned] = await Promise.all([
    findReleasesForLibrary({
      ids: [...latestReleaseIds.values()],
      lang: displayLang,
    }),
    paidPackageIds(ids, userId),
    ownedPackageIds(ids, userId),
  ]);
  const releasesById = new Map(releases.map((release) => [release.id, release]));

  return await Promise.all(packages.map(async (pkg) => {
    const profile = pkg.user.Profile;
    const latestReleaseId = latestReleaseIds.get(pkg.id);
    const latestRelease = latestReleaseId ? releasesById.get(latestReleaseId) : undefined;
    const price = selectPricing(pkg.packagePricing, currency);

    return {
      package: {
        id: pkg.id,
        name: pkg.name,
        displayName: localizedDisplayName(pkg, displayLang) || null,
        shortDescription: localizedShortDescription(pkg, displayLang),
        tags: pkg.tags,
        logoId: pkg.iconFileId,
        logoUrl: await getContentUrl(pkg.iconFileId, request),
        currency: price?.currency || null,
        price: price?.price || null,
        paid: paid.has(pkg.id),
        owned: owned.has(pkg.id),
        owner: {
          id: pkg.userId,
          name: profile?.userName || "",
          displayName: profile?.displayName || "",
          bio: profile?.bio || null,
          iconId: profile?.iconFileId || null,
          iconUrl: await getContentUrl(profile?.iconFileId, request),
        },
      },
      latestRelease: latestRelease
        ? {
          id: latestRelease.id,
          version: latestRelease.version,
          title: latestRelease.title,
          description: localizedReleaseDescription(latestRelease, displayLang),
          targetVersion: latestRelease.targetVersion,
          fileId: latestRelease.fileId,
          fileUrl: latestRelease.fileId ? await nugetFileUrl(latestRelease.fileId, userId) : null,
        }
        : null,
    };
  }));
}

const app = new Hono()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  })
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

    const [pkg] = await createResponses([req.packageId], userId, c.req.raw, req.lang);
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
      const userPackage = await createUserPackage({
        userId: user.id,
        packageId: pkg.package.id,
        requireActivePayment: paymentRequired,
      });
      if (!userPackage) {
        return c.json(await apiErrorResponse("packageIsPrivate"), {
          status: 402,
        });
      }
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

    const lang = c.req.query("lang") ?? await getLanguage(c.req.raw);
    return c.json(await createResponses(
      packages.map((pkg) => pkg.packageId),
      userId,
      c.req.raw,
      lang,
    ));
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
