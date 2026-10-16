import { Hono, type Context } from "hono";
import { compareNugetVersions, isValidNugetVersion, normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { getDb, packageNameFilter } from "@beutl/db";
import { catalogMetadata, catalogReleaseSelect, searchNugetPackages, sortNugetReleases } from "../catalog";
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
  const { totalHits, packages } = await searchNugetPackages(options);
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
        where: { published: true, nugetListed: true, fileId: { not: null } }, select: catalogReleaseSelect,
      } },
    });
    const data = [];
    for (const release of sortNugetReleases(pkg?.Release ?? []).reverse()) {
      if (!release.nugetListed || (!options.prerelease && normalizeNugetVersion(release.version).includes("-"))) continue;
      if (await catalogMetadata(pkg!, release, options.semVer2)) data.push(normalizeNugetVersion(release.version));
    }
    return c.json({ data });
  }
  const { totalHits, packages } = await searchNugetPackages(options);
  const data = [];
  for (const pkg of packages) {
    for (const release of pkg.Release) {
      if (await catalogMetadata(pkg, release, options.semVer2)) { data.push(pkg.name); break; }
    }
  }
  return c.json({ totalHits, data });
});

const REGISTRATION_PAGE_SIZE = 64;

function registrationRoutes(semVer2: boolean) {
  const registration = new Hono<NugetEnv>();
  const releaseWhere = { published: true, fileId: { not: null }, ...(!semVer2 ? { nugetSemVer2: false } : {}) };

  async function registrationPackage(id: string) {
    return (await getDb()).package.findFirst({
      where: { name: packageNameFilter(normalizeNugetId(id)), published: true },
      select: { name: true, Release: {
        where: releaseWhere, select: { id: true, version: true },
      } },
    });
  }

  function pageDescriptor(id: string, releases: { version: string }[], origin: string) {
    const lower = normalizeNugetVersion(releases[0].version);
    const upper = normalizeNugetVersion(releases[releases.length - 1].version);
    return { "@id": registrationUrl(id, origin, undefined, semVer2).replace(/index\.json$/u, `page/${lower}/${upper}.json`),
      parent: registrationUrl(id, origin, undefined, semVer2), count: releases.length, lower, upper };
  }

  async function registrationPage(pkg: { name: string }, versions: { id: string; version: string }[], origin: string) {
    const releases = await (await getDb()).release.findMany({
      where: { id: { in: versions.map((r) => r.id) }, ...releaseWhere },
      select: catalogReleaseSelect,
    });
    const items = [];
    // A legacy archive can require several storage reads. Extract one at a time
    // and never hold manifest/readme bodies for every version in memory.
    for (const release of sortNugetReleases(releases).reverse()) {
      const item = await registrationItem(pkg, release, origin, semVer2);
      if (item) items.push(item);
    }
    return { ...pageDescriptor(pkg.name, versions, origin), count: items.length, items };
  }

  registration.get("/:id/index.json", async (c) => {
    const pkg = await registrationPackage(c.req.param("id"));
    if (!pkg?.Release.length) return c.notFound();
    const origin = nugetOrigin(c);
    const releases = sortNugetReleases(pkg.Release).reverse();
    if (releases.length <= REGISTRATION_PAGE_SIZE) {
      const page = await registrationPage(pkg, releases, origin);
      if (!page.items.length) return c.notFound();
      return c.json({ "@id": registrationUrl(pkg.name, origin, undefined, semVer2), count: 1, items: [{ ...page,
        lower: page.items[0].catalogEntry.version, upper: page.items[page.items.length - 1].catalogEntry.version }] });
    }
    const items = [];
    for (let offset = 0; offset < releases.length; offset += REGISTRATION_PAGE_SIZE) {
      items.push(pageDescriptor(pkg.name, releases.slice(offset, offset + REGISTRATION_PAGE_SIZE), origin));
    }
    return c.json({ "@id": registrationUrl(pkg.name, origin, undefined, semVer2), count: items.length, items });
  });

  registration.get("/:id/page/:lower/:upper", async (c) => {
    const pkg = await registrationPackage(c.req.param("id"));
    if (!pkg) return c.notFound();
    const lower = normalizeNugetVersion(c.req.param("lower"));
    const upper = normalizeNugetVersion(c.req.param("upper").replace(/\.json$/u, ""));
    const releases = sortNugetReleases(pkg.Release).reverse().filter((r) =>
      compareNugetVersions(r.version, lower) >= 0 && compareNugetVersions(r.version, upper) <= 0);
    if (!releases.length || releases.length > REGISTRATION_PAGE_SIZE) return c.notFound();
    return c.json(await registrationPage(pkg, releases, nugetOrigin(c)));
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
