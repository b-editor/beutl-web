import "server-only";
import { Hono } from "hono";
import { drizzle } from "@/drizzle";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { guessCurrency } from "@/lib/currency";
import { getPackage, mapPackage } from "@/lib/api/packages-db";
import { getContentUrl } from "@/lib/db/file";
import { SemVer } from "semver";
import { packages, release } from "@/drizzle/schema";
import { eq, and } from "drizzle-orm";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const currency = await guessCurrency();
    const pkg = await getPackage({
      name: name,
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
    const db = await drizzle();
    const pkg = await db.select({
      id: packages.id,
      userId: packages.userId,
      published: packages.published,
    }).from(packages)
      .where(eq(packages.name, name))
      .limit(1)
      .then((rows) => rows.at(0));
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const releases = await db.select({
      id: release.id,
      version: release.version,
      title: release.title,
      description: release.description,
      targetVersion: release.targetVersion,
      fileId: release.fileId,
    }).from(release)
      .where(and(
        eq(release.packageId, pkg.id),
        pkg.userId === userId ? undefined : eq(release.published, true)));
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
    const db = await drizzle();
    const pkg = await db.select({
      id: packages.id,
      userId: packages.userId,
      published: packages.published,
    }).from(packages)
      .where(eq(packages.name, name))
      .limit(1)
      .then((rows) => rows.at(0));
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const releaseRow = await db.select({
      id: release.id,
      version: release.version,
      title: release.title,
      description: release.description,
      targetVersion: release.targetVersion,
      fileId: release.fileId,
      published: release.published,
    }).from(release)
      .where(and(
        eq(release.packageId, pkg.id),
        eq(release.version, version),
      ))
      .limit(1)
      .then((rows) => rows.at(0));
    if (!releaseRow) {
      return c.json(await apiErrorResponse("releaseNotFound"), { status: 404 });
    }
    if (!releaseRow.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    return c.json({
      id: releaseRow.id,
      version: releaseRow.version,
      title: releaseRow.title,
      description: releaseRow.description,
      targetVersion: releaseRow.targetVersion,
      fileId: releaseRow.fileId,
      fileUrl: await getContentUrl(releaseRow.fileId),
    });
  });

export default app;
