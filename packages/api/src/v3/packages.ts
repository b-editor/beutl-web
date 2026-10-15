import { nugetFileUrl } from "../nuget/tickets";
import { Hono } from "hono";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { guessCurrency } from "../currency";
import { getPackage, mapPackage } from "../api/packages-db";
import { findPackageBasicByName } from "@beutl/db";
import { findReleaseByPackageAndVersion, findReleasesForPackage } from "@beutl/db";
import { compareNugetVersions } from "@beutl/core";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const userId = await getUserId(c);
    const currency = await guessCurrency(c.req.raw);
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
        request: c.req.raw,
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
      return compareNugetVersions(b.version, a.version);
    });

    return c.json(await Promise.all(
      releases.map(async (r) => ({
        id: r.id,
        version: r.version,
        title: r.title,
        description: r.description,
        targetVersion: r.targetVersion,
        fileId: r.fileId,
        fileUrl: r.fileId ? await nugetFileUrl(r.fileId) : null,
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
      fileUrl: release.fileId ? await nugetFileUrl(release.fileId) : null,
    });
  });

export default app;
