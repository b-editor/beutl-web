import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/prisma";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { guessCurrency } from "@/lib/currency";
import { getPackage, mapPackage } from "@/lib/api/packages-db";
import { getContentUrl } from "@/lib/db/file";
import { SemVer } from "semver";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const currency = await guessCurrency();
    const pkg = await getPackage({
      query: {
        name: name,
      },
      userId: userId ?? undefined,
      currency,
    });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    return c.json(
      await mapPackage({
        userId: userId ?? undefined,
        currency,
        pkg,
      }),
    );
  })
  .get("/:name/releases", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const db = await getDbAsync();
    const pkg = await db.package.findFirst({
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

    const releases = await db.release.findMany({
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
    releases.sort((a, b) => {
      return new SemVer(b.version).compare(a.version);
    });

    return c.json(await Promise.all(
      releases.map(async (r) => ({
        id: r.id,
        version: r.version,
        title: r.title,
        description: r.description,
        targetVersion: r.targetVersion,
        fileId: r.fileId,
        fileUrl: await getContentUrl(r.fileId),
      })),
    ));
  })
  .get("/:name/releases/:version", async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const userId = await getUserId(c);

    const db = await getDbAsync();
    const pkg = await db.package.findFirst({
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

    const release = await db.release.findFirst({
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
      fileUrl: await getContentUrl(release.fileId),
    });
  });

export default app;
