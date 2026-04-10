import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/db";
import { packageTable, release } from "@/db/schema";
import { eq, and, ilike } from "drizzle-orm";
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
      where: ilike(packageTable.name, name),
      userId: userId ?? undefined,
      currency: currency ?? undefined,
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
        currency: currency ?? undefined,
        pkg,
      }),
    );
  })
  .get("/:name/releases", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const db = await getDbAsync();
    const pkg = await db.query.packageTable.findFirst({
      where: eq(packageTable.name, name),
      columns: {
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

    const whereCondition = pkg.userId === userId
      ? eq(release.packageId, pkg.id)
      : and(eq(release.packageId, pkg.id), eq(release.published, true));

    const releases = await db.query.release.findMany({
      where: whereCondition,
      columns: {
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
    const pkg = await db.query.packageTable.findFirst({
      where: eq(packageTable.name, name),
      columns: {
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

    const releaseResult = await db.query.release.findFirst({
      where: and(
        eq(release.packageId, pkg.id),
        eq(release.version, version),
      ),
      columns: {
        id: true,
        version: true,
        title: true,
        description: true,
        targetVersion: true,
        fileId: true,
        published: true,
      },
    });
    if (!releaseResult) {
      return c.json(await apiErrorResponse("releaseNotFound"), { status: 404 });
    }
    if (!releaseResult.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    return c.json({
      id: releaseResult.id,
      version: releaseResult.version,
      title: releaseResult.title,
      description: releaseResult.description,
      targetVersion: releaseResult.targetVersion,
      fileId: releaseResult.fileId,
      fileUrl: await getContentUrl(releaseResult.fileId),
    });
  });

export default app;
