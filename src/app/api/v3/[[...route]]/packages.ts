import "server-only";
import { Hono } from "hono";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { guessCurrency } from "@/lib/currency";
import { getPackage, mapPackage } from "@/lib/api/packages-db";
import { getContentUrl } from "@/lib/content-url";
import { findPackageBasicByName } from "@/lib/db/package";
import { findReleaseByPackageAndVersion, findReleasesForPackage } from "@/lib/db/release";
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
    const pkg = await findPackageBasicByName({ name });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const published = pkg.userId === userId ? undefined : true;
    const releases = await findReleasesForPackage({
      packageId: pkg.id,
      published,
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

    const pkg = await findPackageBasicByName({ name });
    if (!pkg) {
      return c.json(await apiErrorResponse("packageNotFound"), { status: 404 });
    }
    if (!pkg.published && pkg.userId !== userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const release = await findReleaseByPackageAndVersion({
      packageId: pkg.id,
      version,
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
