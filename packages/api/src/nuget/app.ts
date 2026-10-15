import { packageNameFilter } from "@beutl/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { NUGET_ORIGIN, normalizeNugetId, normalizeNugetVersion, nugetPackageUrl } from "@beutl/core";
import { ReleaseArtifactLockedError, ReleaseIdentityConflictError, reservePublishedReleaseIdentity, startRetryableTransaction } from "@beutl/db";
import { InvalidNugetPackageError, readNugetIcon, storedPackageReader } from "./archive";
import { findNugetPackage, findNugetVersion, releaseMetadata, searchNugetPackages, sortNugetReleases, type NugetPackage, type NugetRelease } from "./catalog";
import { downloadPackage } from "./download";
import { authenticateNuget } from "./tokens";
import { NugetOwnershipError, NugetPushTooLargeError, pushNugetPackage } from "./push";
import type { createStorageOperations } from "../storage/files";

export type NugetEnv = { Bindings: { NUGET_PUBLIC_ORIGIN?: string; execution?: Parameters<typeof createStorageOperations>[0] } };
const app = new Hono<NugetEnv>({ strict: false });
const origin = (c: Context<NugetEnv>) => (c.env?.NUGET_PUBLIC_ORIGIN || NUGET_ORIGIN).replace(/\/$/u, "");
const integer = (value: string | undefined, fallback: number, max: number) => value && /^\d+$/u.test(value) ? Math.min(Number(value), max) : fallback;

app.use("/v3/*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], allowHeaders: ["Authorization", "Range"], exposeHeaders: ["Content-Length", "Content-Range"] }));
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/", (c) => c.json({ service: "Beutl NuGet", index: `${origin(c)}/v3/index.json` }));
app.get("/v3/index.json", (c) => {
  const base = origin(c);
  return c.json({ version: "3.0.0", resources: [
    { "@id": `${base}/v3/package/`, "@type": "PackageBaseAddress/3.0.0" },
    { "@id": `${base}/v3/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
    { "@id": `${base}/v3/registration/`, "@type": "RegistrationsBaseUrl/3.0.0-rc" },
    { "@id": `${base}/v3/search`, "@type": "SearchQueryService/3.5.0" },
    { "@id": `${base}/v3/search`, "@type": "SearchQueryService/3.4.0" },
    { "@id": `${base}/v3/search`, "@type": "SearchQueryService/3.0.0-beta" },
    { "@id": `${base}/v3/search`, "@type": "SearchQueryService/3.0.0-rc" },
    { "@id": `${base}/v3/autocomplete`, "@type": "SearchAutocompleteService/3.5.0" },
    { "@id": `${base}/v3/autocomplete`, "@type": "SearchAutocompleteService/3.0.0-rc" },
    { "@id": `${base}/v3/autocomplete`, "@type": "SearchAutocompleteService/3.0.0-beta" },
    { "@id": `${base}/api/v2/package`, "@type": "PackagePublish/2.0.0" },
  ] });
});

app.get("/v3/search", async (c) => {
  const result = await searchNugetPackages({ query: c.req.query("q"), prerelease: c.req.query("prerelease") === "true",
    skip: integer(c.req.query("skip"), 0, 100000), take: integer(c.req.query("take"), 20, 100) });
  const data = await Promise.all(result.packages.map(async (pkg) => {
    const releases = sortNugetReleases(pkg.Release), latest = releases[0];
    const { metadata: m } = await releaseMetadata(pkg, latest);
    return { "@id": `${origin(c)}/v3/registration/${normalizeNugetId(pkg.name)}/index.json`, id: pkg.name, version: normalizeNugetVersion(latest.version),
      title: m.title, description: m.description, summary: m.summary, authors: m.authors.split(/[,;]/u).map((s) => s.trim()), tags: m.tags,
      projectUrl: m.projectUrl, licenseUrl: m.licenseUrl, iconUrl: m.icon ? `${origin(c)}/v3/package/${normalizeNugetId(pkg.name)}/${normalizeNugetVersion(latest.version)}/icon` : m.iconUrl,
      totalDownloads: releases.reduce((sum, r) => sum + Number(r.downloads), 0), verified: false,
      versions: releases.reverse().map((r) => ({ version: normalizeNugetVersion(r.version), downloads: Number(r.downloads),
        "@id": `${origin(c)}/v3/registration/${normalizeNugetId(pkg.name)}/${normalizeNugetVersion(r.version)}.json` })) };
  }));
  return c.json({ totalHits: result.totalHits, data });
});

app.get("/v3/autocomplete", async (c) => {
  const id = c.req.query("id"), prerelease = c.req.query("prerelease") === "true";
  if (id) {
    const pkg = await findNugetPackage(id);
    return c.json({ data: pkg ? sortNugetReleases(pkg.Release.filter((r) => r.nugetListed && (prerelease || !r.version.includes("-"))))
      .reverse().map((r) => normalizeNugetVersion(r.version)) : [] });
  }
  const result = await searchNugetPackages({ query: c.req.query("q"), prerelease,
    skip: integer(c.req.query("skip"), 0, 100000), take: integer(c.req.query("take"), 20, 100) });
  return c.json({ totalHits: result.totalHits, data: result.packages.map((p) => p.name) });
});

async function registrationItem(pkg: NugetPackage, release: NugetRelease, base: string) {
  const name = normalizeNugetId(pkg.name), version = normalizeNugetVersion(release.version);
  const { metadata: m } = await releaseMetadata(pkg, release);
  const packageContent = nugetPackageUrl(name, version, base);
  const url = `${base}/v3/registration/${name}/${version}.json`;
  return { "@id": url, packageContent, catalogEntry: {
    "@id": `${url}#catalog`, id: pkg.name, version, listed: release.nugetListed,
    published: release.createdAt.toISOString(), packageContent, title: m.title, description: m.description, summary: m.summary,
    authors: m.authors, tags: m.tags, projectUrl: m.projectUrl, licenseUrl: m.licenseUrl,
    requireLicenseAcceptance: m.requireLicenseAcceptance, dependencyGroups: m.dependencyGroups.map((g) => ({
      ...(g.targetFramework ? { targetFramework: g.targetFramework } : {}),
      dependencies: g.dependencies.map((d) => ({ id: d.id, range: d.range, registration: `${base}/v3/registration/${normalizeNugetId(d.id)}/index.json` })),
    })),
  } };
}

app.get("/v3/registration/:id/index.json", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  if (!pkg?.Release.length) return c.notFound();
  const sorted = sortNugetReleases(pkg.Release).reverse();
  const items = await Promise.all(sorted.map((r) => registrationItem(pkg, r, origin(c))));
  const url = `${origin(c)}/v3/registration/${normalizeNugetId(pkg.name)}/index.json`;
  return c.json({ "@id": url, count: 1, items: [{ "@id": url, count: items.length, lower: normalizeNugetVersion(sorted[0].version),
    upper: normalizeNugetVersion(sorted[sorted.length - 1].version), items }] });
});
app.get("/v3/registration/:id/:version", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  const release = pkg && findNugetVersion(pkg, c.req.param("version").replace(/\.json$/u, ""));
  if (!pkg || !release) return c.notFound();
  const item = await registrationItem(pkg, release, origin(c));
  return c.json({ ...item, listed: release.nugetListed, published: release.createdAt.toISOString(),
    registration: `${origin(c)}/v3/registration/${normalizeNugetId(pkg.name)}/index.json` });
});

app.on(["GET", "HEAD"], "/v3/package/:id/index.json", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  if (!pkg?.Release.length) return c.notFound();
  return c.json({ versions: sortNugetReleases(pkg.Release).reverse().map((r) => normalizeNugetVersion(r.version)) });
});
app.on(["GET", "HEAD"], "/v3/files/:fileId", (c) => downloadPackage(c.req.raw, c.req.param("fileId")));
app.on(["GET", "HEAD"], "/v3/package/:id/:version/:fileName", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  const release = pkg && findNugetVersion(pkg, c.req.param("version"));
  if (!pkg || !release?.file) return c.notFound();
  const name = normalizeNugetId(pkg.name), version = normalizeNugetVersion(release.version), filename = c.req.param("fileName").toLowerCase();
  if (filename === `${name}.${version}.nupkg`) return downloadPackage(c.req.raw, release.file.id);
  const data = await releaseMetadata(pkg, release);
  if (filename === `${name}.nuspec`) return new Response(c.req.method === "HEAD" ? null : data.nuspec, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
  if (filename === "readme" && data.readme !== null) return new Response(c.req.method === "HEAD" ? null : data.readme, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (filename === "icon" && data.metadata.icon) {
    const bytes = await readNugetIcon(storedPackageReader(release.file.objectKey, Number(release.file.size)), data.metadata.icon);
    if (!bytes) return c.notFound();
    // Only raster icons are rendered on this origin; all other formats download.
    const ext = data.metadata.icon.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
    return new Response(c.req.method === "HEAD" ? null : bytes, { headers: { "Content-Type": mime, "Content-Security-Policy": "default-src 'none'; sandbox" } });
  }
  return c.notFound();
});

app.put("/api/v2/package", async (c) => {
  const auth = await authenticateNuget(c.req.raw.headers);
  if (!auth?.canPush) { await c.req.raw.body?.cancel(); return c.json({ message: "A push-enabled API key is required" }, auth ? 403 : 401); }
  const result = await pushNugetPackage(c.req.raw, auth.userId, c.env?.execution);
  return result.kind === "created" ? c.body(null, 201) : c.json({ message: "Storage quota exceeded" }, 413);
});
app.on(["DELETE", "POST"], "/api/v2/package/:id/:version", async (c) => {
  const auth = await authenticateNuget(c.req.raw.headers);
  if (!auth?.canPush) return c.json({ message: "A push-enabled API key is required" }, auth ? 403 : 401);
  const result = await startRetryableTransaction(async (tx) => {
    const pkg = await tx.package.findFirst({ where: { name: packageNameFilter(normalizeNugetId(c.req.param("id"))) }, include: { Release: true } });
    if (!pkg) return 404;
    if (pkg.userId !== auth.userId) return 403;
    const version = normalizeNugetVersion(c.req.param("version"));
    const release = pkg.Release.find((r) => normalizeNugetVersion(r.version) === version);
    if (!release?.published || !release.fileId) return 404;
    await reservePublishedReleaseIdentity(tx, release);
    await tx.release.update({ where: { id: release.id }, data: { nugetListed: c.req.method === "POST", artifactLocked: true } });
    return c.req.method === "DELETE" ? 204 : 200;
  });
  return c.body(null, result as 200 | 204 | 403 | 404);
});

app.onError((error, c) => {
  if (error instanceof ReleaseIdentityConflictError || error instanceof ReleaseArtifactLockedError ||
    ("code" in error && error.code === "P2002")) return c.json({ message: "This package version already exists or was previously published" }, 409);
  if (error instanceof NugetOwnershipError) return c.json({ message: "Package belongs to another account" }, 403);
  if (error instanceof NugetPushTooLargeError) return c.json({ message: "The maximum push size is 50 MiB" }, 413);
  if (error instanceof InvalidNugetPackageError || /^Invalid NuGet (package ID|version)$/u.test(error.message)) return c.json({ message: error.message }, 400);
  console.error("NuGet request failed", error);
  return c.json({ message: "NuGet request failed" }, 500);
});

export default app;
