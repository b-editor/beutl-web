import "server-only";
import { Hono } from "hono";
import { prisma } from "@/prisma";
import { getUserId } from "./auth";
import { apiErrorResponse } from "./error";
import { packagePaied } from "@/lib/store-utils";
import { guessCurrency } from "@/lib/currency";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const currency = await guessCurrency();
    const pkg = await prisma.package.findFirst({
      where: {
        name: name,
      },
      select: {
        id: true,
        published: true,
        userId: true,
        user: {
          select: {
            Profile: {
              select: {
                displayName: true,
                userName: true,
                bio: true,
                iconFileId: true,
              },
            },
          },
        },
        name: true,
        displayName: true,
        description: true,
        shortDescription: true,
        webSite: true,
        tags: true,
        iconFileId: true,
        PackageScreenshot: {
          select: {
            fileId: true,
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
        UserPackage: userId
          ? {
              where: {
                userId: userId,
              },
              select: {
                packageId: true,
              },
              take: 1,
            }
          : undefined,
      },
    });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const owned = pkg.UserPackage.length > 0;
    let paied = false;
    if (userId) {
      paied = await packagePaied(pkg.id, userId);
    }

    const price =
      pkg.packagePricing.find((p) => p.currency === currency) ||
      pkg.packagePricing.find((p) => p.fallback) ||
      pkg.packagePricing[0];

    return c.json({
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      description: pkg.description,
      shortDescription: pkg.shortDescription,
      website: pkg.webSite,
      tags: pkg.tags,
      logoId: pkg.iconFileId,
      logoUrl: pkg.iconFileId
        ? `https://beutl.beditor.net/api/contents/${pkg.iconFileId}`
        : null,
      currency: price.currency,
      price: price,
      owned: owned,
      paied: paied,
      owner: {
        id: pkg.userId,
        displayName: pkg.user.Profile?.displayName || "",
        name: pkg.user.Profile?.userName || "",
        bio: pkg.user.Profile?.bio,
        iconId: pkg.user.Profile?.iconFileId,
        iconUrl: pkg.user.Profile?.iconFileId
          ? `https://beutl.beditor.net/api/contents/${pkg.user.Profile?.iconFileId}`
          : null,
      },
    });
  })
  .get("/:name/releases", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const pkg = await prisma.package.findFirst({
      where: {
        name: name,
      },
      select: {
        id: true,
        userId: true,
        published: true,
      },
    });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const releases = await prisma.release.findMany({
      where: {
        packageId: pkg.id,
        published: pkg.userId === userId ? undefined : true,
      },
      select: {
        id: true,
        version: true,
        title: true,
        description: true,
        targetVersion: true,
        fileId: true,
      },
    });

    return c.json(
      releases.map((r) => ({
        id: r.id,
        version: r.version,
        title: r.title,
        description: r.description,
        targetVersion: r.targetVersion,
        fileId: r.fileId,
        fileUrl: r.fileId
          ? `https://beutl.beditor.net/api/contents/${r.fileId}`
          : null,
      })),
    );
  })
  .get("/:name/releases/:version", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const userId = await getUserId(c);

    const pkg = await prisma.package.findFirst({
      where: {
        name: name,
      },
      select: {
        id: true,
        userId: true,
        published: true,
      },
    });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const release = await prisma.release.findFirst({
      where: {
        packageId: pkg.id,
        version: version,
      },
      select: {
        id: true,
        version: true,
        title: true,
        description: true,
        targetVersion: true,
        fileId: true,
        published: true,
      },
    });
    if (!release) {
      return c.json(await apiErrorResponse("releaseNotFound"), { status: 404 });
    }
    if (!release.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    return c.json({
      id: release.id,
      version: release.version,
      title: release.title,
      description: release.description,
      targetVersion: release.targetVersion,
      fileId: release.fileId,
      fileUrl: release.fileId
        ? `https://beutl.beditor.net/api/contents/${release.fileId}`
        : null,
    });
  });

export default app;
