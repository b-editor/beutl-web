import { nugetFileUrl } from "../nuget/tickets";
import { Hono } from "hono";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { packageOwned, packagePaied } from "../store-utils";
import { guessCurrency } from "../currency";
import { compareNugetVersions, localizedDisplayName, localizedReleaseDescription, localizedShortDescription } from "@beutl/core";
import { getContentUrl } from "../content-url";
import { selectPricing } from "@beutl/core";
import { getLanguage } from "../lang-utils";
import {
  existsPaidPricingForPackage,
  findPackageForLibraryResponse,
} from "@beutl/db";
import { findReleaseForLibrary } from "@beutl/db";
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

async function createResponse(
  pkgId: string,
  userId: string | null,
  request?: Request,
  lang?: string,
) {
  const currency = await guessCurrency(request);
  const displayLang = lang ?? await getLanguage(request);
  const pkg = await findPackageForLibraryResponse({
    id: pkgId,
    currency,
    lang: displayLang,
  });
  if (!pkg || !pkg.published) {
    return null;
  }
  const profile = pkg.user.Profile;
  pkg.Release.sort((a, b) => {
    return compareNugetVersions(b.version, a.version);
  });
  const latestReleaseId = pkg.Release?.[0]?.id;
  const latestRelease = latestReleaseId
    ? await findReleaseForLibrary({
      id: latestReleaseId,
      lang: displayLang,
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
      displayName: localizedDisplayName(pkg, displayLang) || null,
      shortDescription: localizedShortDescription(pkg, displayLang),
      tags: pkg.tags,
      logoId: pkg.iconFileId,
      logoUrl: await getContentUrl(pkg.iconFileId, request),
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

    const pkg = await createResponse(req.packageId, userId, c.req.raw, req.lang);
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
    const items = await Promise.all(
      packages.map(
        async (pkg) => await createResponse(pkg.packageId, userId, c.req.raw, lang),
      ),
    );
    return c.json(items.filter((item) => item !== null));
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
