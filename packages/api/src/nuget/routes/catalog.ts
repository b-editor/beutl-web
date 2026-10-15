import { Hono, type Context } from "hono";
import { normalizeNugetVersion } from "@beutl/core";
import { findNugetPackage, findNugetVersion, searchNugetPackages, sortNugetReleases } from "../catalog";
import { nugetOrigin, registrationItem, registrationUrl, searchItem, serviceIndex, type NugetEnv } from "../protocol";

const routes = new Hono<NugetEnv>();

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  return value && /^\d+$/u.test(value) ? Math.min(Number(value), max) : fallback;
}

function searchOptions(c: Context<NugetEnv>) {
  return {
    query: c.req.query("q"),
    prerelease: c.req.query("prerelease") === "true",
    skip: boundedInteger(c.req.query("skip"), 0, 100000),
    take: boundedInteger(c.req.query("take"), 20, 100),
  };
}

routes.get("/index.json", (c) => c.json(serviceIndex(nugetOrigin(c))));

routes.get("/search", async (c) => {
  const { totalHits, packages } = await searchNugetPackages(searchOptions(c));
  const origin = nugetOrigin(c);
  const data = await Promise.all(packages.map((pkg) => searchItem(pkg, origin)));
  return c.json({ totalHits, data });
});

routes.get("/autocomplete", async (c) => {
  const id = c.req.query("id");
  const options = searchOptions(c);
  if (id) {
    const pkg = await findNugetPackage(id);
    const releases = pkg?.Release.filter((release) =>
      release.nugetListed && (options.prerelease || !release.version.includes("-"))) ?? [];
    return c.json({
      data: sortNugetReleases(releases).reverse().map((release) => normalizeNugetVersion(release.version)),
    });
  }
  const { totalHits, packages } = await searchNugetPackages(options);
  return c.json({ totalHits, data: packages.map((pkg) => pkg.name) });
});

routes.get("/registration/:id/index.json", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  if (!pkg?.Release.length) return c.notFound();

  const origin = nugetOrigin(c);
  const releases = sortNugetReleases(pkg.Release).reverse();
  const items = await Promise.all(releases.map((release) => registrationItem(pkg, release, origin)));
  const url = registrationUrl(pkg.name, origin);
  return c.json({
    "@id": url,
    count: 1,
    items: [{
      "@id": url,
      count: items.length,
      lower: normalizeNugetVersion(releases[0].version),
      upper: normalizeNugetVersion(releases[releases.length - 1].version),
      items,
    }],
  });
});

routes.get("/registration/:id/:version", async (c) => {
  const pkg = await findNugetPackage(c.req.param("id"));
  const release = pkg && findNugetVersion(pkg, c.req.param("version").replace(/\.json$/u, ""));
  if (!pkg || !release) return c.notFound();

  const origin = nugetOrigin(c);
  const item = await registrationItem(pkg, release, origin);
  return c.json({
    ...item,
    listed: release.nugetListed,
    published: release.createdAt.toISOString(),
    registration: registrationUrl(pkg.name, origin),
  });
});

export default routes;
