import "server-only";
import { Hono } from "hono";
import { prisma } from "@/prisma";
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
  const pkg = await prisma.package.findFirst({
    where: {
      id: pkgId,
    },
    select: {
      published: true,
      id: true,
      name: true,
      displayName: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
              displayName: true,
              bio: true,
              iconFileId: true,
            },
          },
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
      Release: {
        select: {
          id: true,
          version: true,
        },
      },
    },
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
    ? await prisma.release.findFirst({
        where: {
          id: latestReleaseId,
        },
        select: {
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
    pkg.packagePricing.find((p) => p.currency === currency) ||
    pkg.packagePricing.find((p) => p.fallback) ||
    pkg.packagePricing[0];

  return {
    package: {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      shortDescription: pkg.shortDescription,
      tags: pkg.tags,
      logoId: pkg.iconFileId,
      logoUrl: getContentUrl(pkg.iconFileId),
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
        iconUrl: getContentUrl(profile?.iconFileId),
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
          fileUrl: getContentUrl(latestRelease.fileId),
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

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
      },
    });
    if (!user) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    const pkg = await createResponse(req.packageId, userId);
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }

    const paymentRequired = !!(await prisma.packagePricing.findFirst({
      where: {
        packageId: pkg.package.id,
        price: {
          gt: 0,
        },
      },
      select: {
        id: true,
      },
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
      !(await prisma.userPackage.findFirst({
        where: {
          userId: user.id,
          packageId: pkg.package.id,
        },
      }))
    ) {
      await prisma.userPackage.create({
        data: {
          userId: user.id,
          packageId: pkg.package.id,
        },
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

    const packages = await prisma.userPackage.findMany({
      where: {
        userId: userId,
      },
      select: {
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

    await prisma.userPackage.deleteMany({
      where: {
        userId: userId,
        package: {
          name: name,
        },
      },
    });

    return c.text("Deleted");
  });

export default app;
