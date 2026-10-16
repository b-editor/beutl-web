import { Hono, type Context } from "hono";
import { compareNugetVersions, isValidNugetVersion, normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { getDb, packageNameFilter } from "@beutl/db";
import { catalogMetadata, catalogReleaseSelect, classifyNugetReleases, searchNugetPackages, sortNugetReleases } from "../catalog";
import { nugetOrigin, registrationItem, registrationUrl, searchItem, serviceIndex, type NugetEnv } from "../protocol";

const routes = new Hono<NugetEnv>();

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  return value && /^\d+$/u.test(value) ? Math.min(Number(value), max) : fallback;
}

function searchOptions(c: Context<NugetEnv>) {
  const level = c.req.query("semVerLevel");
  return {
    query: c.req.query("q"),
    prerelease: c.req.query("prerelease") === "true",
    semVer2: !!level && isValidNugetVersion(level) && compareNugetVersions(level, "2.0.0") >= 0,
    skip: boundedInteger(c.req.query("skip"), 0, 100000),
    take: boundedInteger(c.req.query("take"), 20, 100),
  };
}

routes.get("/index.json", (c) => c.json(serviceIndex(nugetOrigin(c))));

routes.get("/search", async (c) => {
  const options = searchOptions(c);
  const { totalHits, packages } = await searchNugetPackages({ ...options, filterReadable: true });
  const origin = nugetOrigin(c);
  const data = [];
  // Legacy entries may extract multi-megabyte ZIP directories from storage.
  for (const pkg of packages) {
    const item = await searchItem(pkg, origin, options.semVer2);
    if (item) data.push(item);
  }
  return c.json({ totalHits, data });
});

routes.get("/autocomplete", async (c) => {
  const id = c.req.query("id");
  const options = searchOptions(c);
  if (id) {
    const pkg = await (await getDb()).package.findFirst({
      where: { name: packageNameFilter(normalizeNugetId(id)), published: true },
      select: { name: true, Release: {
        where: { published: true, nugetListed: true, fileId: { not: null }, nugetMetadataInvalid: false }, select: catalogReleaseSelect,
      } },
    });
    const data = [];
    for (const release of sortNugetReleases(pkg?.Release ?? []).reverse()) {
      if (!release.nugetListed || (!options.prerelease && normalizeNugetVersion(release.version).includes("-"))) continue;
      if (await catalogMetadata(pkg!, release, options.semVer2)) data.push(normalizeNugetVersion(release.version));
    }
    return c.json({ data: data.slice(options.skip, options.skip + options.take) });
  }
  const { totalHits, packages } = await searchNugetPackages({ ...options, filterReadable: true });
  return c.json({ totalHits, data: packages.map((pkg) => pkg.name) });
});

const REGISTRATION_PAGE_SIZE = 64;

function registrationRoutes(semVer2: boolean) {
  const registration = new Hono<NugetEnv>();
  const releaseWhere = { published: true, fileId: { not: null }, nugetMetadataInvalid: false, ...(!semVer2 ? { nugetSemVer2: false } : {}) };

  async function registrationPackage(id: string, classify = false) {
    const db = await getDb();
    const pkg = await db.package.findFirst({
      where: { name: packageNameFilter(normalizeNugetId(id)), published: true },
      select: { id: true, name: true, Release: {
        where: releaseWhere, select: { id: true, version: true },
      } },
    });
    if (!pkg || !classify) return pkg;
    const excluded = await classifyNugetReleases({ ...releaseWhere, packageId: pkg.id }, semVer2);
    pkg.Release = pkg.Release.filter((release) => !excluded.has(release.id));
    return pkg;
  }

  function pageDescriptor(id: string, releases: { version: string }[], origin: string) {
    const lower = normalizeNugetVersion(releases[0].version);
    const upper = normalizeNugetVersion(releases[releases.length - 1].version);
    return { "@id": registrationUrl(id, origin, undefined, semVer2).replace(/index\.json$/u, `page/${lower}/${upper}.json`),
      parent: registrationUrl(id, origin, undefined, semVer2), count: releases.length, lower, upper };
  }

  async function registrationPage(pkg: { name: string }, versions: { id: string; version: string }[], origin: string) {
    const db = await getDb();
    const items = [];
    // New publications can expand a range already advertised to a client.
    // Keep serving that range, fetching metadata in bounded batches.
    for (let offset = 0; offset < versions.length; offset += REGISTRATION_PAGE_SIZE) {
      const releases = await db.release.findMany({
        where: { id: { in: versions.slice(offset, offset + REGISTRATION_PAGE_SIZE).map((r) => r.id) }, ...releaseWhere },
        select: catalogReleaseSelect,
      });
      for (const release of sortNugetReleases(releases).reverse()) {
        const item = await registrationItem(pkg, release, origin, semVer2);
        if (item) items.push(item);
      }
    }
    return items.length ? { ...pageDescriptor(pkg.name, items.map((item) => item.catalogEntry), origin), items } : null;
  }

  registration.get("/:id/index.json", async (c) => {
    const pkg = await registrationPackage(c.req.param("id"), true);
    if (!pkg?.Release.length) return c.notFound();
    const origin = nugetOrigin(c);
    const releases = sortNugetReleases(pkg.Release).reverse();
    if (releases.length <= REGISTRATION_PAGE_SIZE) {
      const page = await registrationPage(pkg, releases, origin);
      if (!page) return c.notFound();
      return c.json({ "@id": registrationUrl(pkg.name, origin, undefined, semVer2), count: 1, items: [page] });
    }
    const items = [];
    for (let offset = 0; offset < releases.length; offset += REGISTRATION_PAGE_SIZE) {
      items.push(pageDescriptor(pkg.name, releases.slice(offset, offset + REGISTRATION_PAGE_SIZE), origin));
    }
    return c.json({ "@id": registrationUrl(pkg.name, origin, undefined, semVer2), count: items.length, items });
  });

  registration.get("/:id/page/:lower/:upper", async (c) => {
    const pkg = await registrationPackage(c.req.param("id"), true);
    if (!pkg) return c.notFound();
    const lower = normalizeNugetVersion(c.req.param("lower"));
    const upper = normalizeNugetVersion(c.req.param("upper").replace(/\.json$/u, ""));
    const releases = sortNugetReleases(pkg.Release).reverse().filter((r) =>
      compareNugetVersions(r.version, lower) >= 0 && compareNugetVersions(r.version, upper) <= 0);
    if (!releases.length) return c.notFound();
    const page = await registrationPage(pkg, releases, nugetOrigin(c));
    return page ? c.json(page) : c.notFound();
  });

  registration.get("/:id/:version", async (c) => {
    const pkg = await registrationPackage(c.req.param("id"));
    const version = normalizeNugetVersion(c.req.param("version").replace(/\.json$/u, ""));
    const candidate = pkg?.Release.find((r) => normalizeNugetVersion(r.version) === version);
    const release = candidate && await (await getDb()).release.findFirst({
      where: { id: candidate.id, ...releaseWhere }, select: catalogReleaseSelect,
    });
    if (!pkg || !release) return c.notFound();

    const origin = nugetOrigin(c);
    const item = await registrationItem(pkg, release, origin, semVer2);
    if (!item) return c.notFound();
    return c.json({
      ...item,
      listed: release.nugetListed,
      published: release.createdAt.toISOString(),
      registration: registrationUrl(pkg.name, origin, undefined, semVer2),
    });
  });
  return registration;
}

routes.route("/registration", registrationRoutes(true));
routes.route("/registration-semver1", registrationRoutes(false));

export default routes;
