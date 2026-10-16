import { Hono } from "hono";
import { normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { getDb, packageNameFilter } from "@beutl/db";
import { readNugetIcon, storedPackageReader } from "../archive";
import { classifyNugetReleases, findNugetPackage, findNugetVersion, releaseMetadata, sortNugetReleases } from "../catalog";
import { downloadPackage } from "../download";
import type { NugetEnv } from "../protocol";

const routes = new Hono<NugetEnv>();

routes.on(["GET", "HEAD"], "/package/:id/index.json", async (c) => {
  const releaseWhere = { published: true, fileId: { not: null }, nugetMetadataInvalid: false };
  const pkg = await (await getDb()).package.findFirst({
    where: { name: packageNameFilter(normalizeNugetId(c.req.param("id"))), published: true },
    select: { id: true, Release: {
      where: releaseWhere, select: { id: true, version: true },
    } },
  });
  if (!pkg?.Release.length) return c.notFound();
  const excluded = await classifyNugetReleases({ ...releaseWhere, packageId: pkg.id }, true);
  const releases = pkg.Release.filter((release) => !excluded.has(release.id));
  if (!releases.length) return c.notFound();
  return c.json({
    versions: sortNugetReleases(releases).reverse().map((release) => normalizeNugetVersion(release.version)),
  });
});

routes.on(["GET", "HEAD"], "/files/:fileId", (c) => downloadPackage(c.req.raw, c.req.param("fileId"), c.env?.execution));

routes.on(["GET", "HEAD"], "/package/:id/:version/:fileName", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"), undefined, c.req.param("version"));
  const release = pkg && findNugetVersion(pkg, c.req.param("version"));
  if (!pkg || !release?.file) return c.notFound();

  const name = normalizeNugetId(pkg.name);
  const version = normalizeNugetVersion(release.version);
  const filename = c.req.param("fileName").toLowerCase();
  if (filename === `${name}.${version}.nupkg`) return downloadPackage(c.req.raw, release.file.id, c.env?.execution);

  const data = await releaseMetadata(pkg, release);
  const isHead = c.req.method === "HEAD";
  if (filename === `${name}.nuspec`) {
    return new Response(isHead ? null : data.nuspec, {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }
  if (filename === "readme" && data.readme !== null) {
    return new Response(isHead ? null : data.readme, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (filename === "icon" && data.metadata.icon) {
    const reader = storedPackageReader(release.file.objectKey, Number(release.file.size));
    const bytes = await readNugetIcon(reader, data.metadata.icon);
    if (!bytes) return c.notFound();
    // Only raster icons are rendered on this origin; all other formats download.
    const extension = data.metadata.icon.split(".").pop()?.toLowerCase();
    const mime = extension === "png" ? "image/png"
      : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "application/octet-stream";
    return new Response(isHead ? null : bytes, {
      headers: { "Content-Type": mime, "Content-Security-Policy": "default-src 'none'; sandbox" },
    });
  }
  return c.notFound();
});

export default routes;
