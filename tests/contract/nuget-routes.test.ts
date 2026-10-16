import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import app from "../../packages/api/src/nuget/app";
import { parseNuspec } from "../../packages/api/src/nuget/archive";
import { releaseMetadata, type NugetRelease } from "../../packages/api/src/nuget/catalog";
import { nugetFileUrl, verifyDownloadTicket } from "../../packages/api/src/nuget/tickets";

const secret = `bn_${"a".repeat(64)}`;
const manifest = '<package><metadata><id>Library</id><version>1.0.0</version><authors>Author</authors><description>Library</description></metadata></package>';
const release = { id: "release", packageId: "pkg", version: "1.0.0", published: true, artifactLocked: true, nugetListed: false,
  fileId: "file", file: { id: "file", objectKey: "object", size: 4n }, downloads: 0n, createdAt: new Date("2026-01-01"),
  nugetSemVer2: false, nugetMetadata: parseNuspec(manifest), nuspec: manifest, readme: null };
const pkg = { id: "pkg", name: "Library", audience: "DEVELOPMENT", userId: "owner", published: true, Release: [release] };
let paid = false, buyer: string | null = null, revoked = false, canPush = true;
const file = () => ({ name: "library.nupkg", size: 4n, objectKey: "object", sha256: "abc", userId: "owner", visibility: "DEDICATED",
  Package: [], Profile: [], PackageScreenshot: [], aiJobResult: null,
  Release: [{ published: true, package: { ...pkg, packagePricing: paid ? [{ id: "price", price: 100 }] : [] } }] });
const models = {
  package: { findFirst: vi.fn(async () => structuredClone(pkg)), findUniqueOrThrow: vi.fn(async () => pkg), findMany: vi.fn(async () => [] as (typeof pkg)[]), count: vi.fn(async () => 0), update: vi.fn() },
  release: { findFirst: vi.fn(async () => release), findMany: vi.fn(async () => [release]), updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => release) },
  file: { findFirst: vi.fn(async () => file()) },
  nugetToken: { findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => where.tokenHash === createHash("sha256").update(secret).digest("hex") ?
    { userId: buyer || "owner", canPush, revokedAt: revoked ? new Date() : null, expiresAt: new Date(Date.now() + 100000) } : null) },
  userPaymentHistory: { findFirst: vi.fn(async () => buyer === "buyer" ? { id: "purchase" } : null) },
  publishedPackageVersion: { upsert: vi.fn(async () => ({ releaseId: "release" })) },
};
const bucket = { put: vi.fn(), get: vi.fn(async () => ({ body: new Blob(["test"]).stream() })) };
const request = (path: string, init?: RequestInit) => app.request(`https://nuget.beditor.net${path}`, init);

beforeEach(() => {
  vi.clearAllMocks(); paid = false; buyer = null; revoked = false; canPush = true;
  release.nugetListed = false;
  vi.stubEnv("NUGET_DOWNLOAD_SECRET", "nuget-test-download-secret");
  setDbProvider(async () => ({ ...models, $transaction: async (fn: (tx: unknown) => unknown) => fn(models) }) as never);
  setR2BucketProvider(() => bucket);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("NuGet registry routes", () => {
  it("advertises API resources on the NuGet origin", async () => {
    const result = await (await request("/v3/index.json")).json();
    expect(result.version).toBe("3.0.0");
    expect(result.resources).toContainEqual({ "@type": "PackagePublish/2.0.0", "@id": "https://nuget.beditor.net/api/v2/package" });
    // NuGet.Client uses these types to discover search/autocomplete. Advertising
    // only 3.5.0 and 3.0.0-rc leaves ordinary `dotnet package search` unsupported.
    expect(result.resources).toContainEqual({ "@type": "SearchQueryService/3.4.0", "@id": "https://nuget.beditor.net/v3/search" });
    expect(result.resources).toContainEqual({ "@type": "SearchQueryService/3.0.0-beta", "@id": "https://nuget.beditor.net/v3/search" });
    expect(result.resources).toContainEqual({ "@type": "SearchAutocompleteService/3.0.0-beta", "@id": "https://nuget.beditor.net/v3/autocomplete" });
    expect(result.resources.some((resource: { "@type": string }) => resource["@type"].endsWith("/3.5.0"))).toBe(false);
    expect(result.resources).toContainEqual({ "@type": "RegistrationsBaseUrl/3.6.0", "@id": "https://nuget.beditor.net/v3/registration/" });
    expect(result.resources).toContainEqual({ "@type": "RegistrationsBaseUrl/3.0.0-rc", "@id": "https://nuget.beditor.net/v3/registration-semver1/" });
    expect((await request("/ja/packages")).status).toBe(404);
  });
  it("keeps unlisted versions in the flat container and registration", async () => {
    expect(await (await request("/v3/package/LIBRARY/index.json")).json()).toEqual({ versions: ["1.0.0"] });
    const result = await (await request("/v3/registration/library/index.json")).json();
    expect(result.items[0].items[0].catalogEntry.listed).toBe(false);
    expect(await (await request("/v3/package/library/1.0.0/library.1.0.0.nupkg")).text()).toBe("test");
    expect(models.nugetToken.findUnique).not.toHaveBeenCalled();
  });
  it("uses the configured origin and normalized links across catalog responses", async () => {
    const origin = "https://packages.example.test";
    const env = { NUGET_PUBLIC_ORIGIN: `${origin}/` };
    const versions = ["1.10.0", "1.2.0", "01.11.0.0-Beta.2+build"];
    const catalog = {
      ...pkg,
      Release: versions.map((version, index) => ({
        ...release, id: `release-${index}`, version, downloads: BigInt(index + 1), nugetListed: true,
      })),
    };
    models.package.findMany.mockResolvedValueOnce([catalog]);
    models.package.count.mockResolvedValueOnce(1);
    const search = await app.request(`${origin}/v3/search?q=Library&skip=4&take=8&prerelease=true&semVerLevel=2.0.0`, {}, env);
    const result = await search.json();
    expect(result.totalHits).toBe(1);
    expect(result.data[0]).toMatchObject({
      "@id": `${origin}/v3/registration/library/index.json`,
      version: "1.11.0-beta.2", totalDownloads: 6,
      versions: [
        { version: "1.2.0", "@id": `${origin}/v3/registration/library/1.2.0.json` },
        { version: "1.10.0", "@id": `${origin}/v3/registration/library/1.10.0.json` },
        { version: "1.11.0-beta.2", "@id": `${origin}/v3/registration/library/1.11.0-beta.2.json` },
      ],
    });
    expect(models.package.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 8 }));

    models.package.findFirst.mockResolvedValueOnce(catalog);
    models.release.findMany.mockResolvedValueOnce(catalog.Release);
    const registration = await (await app.request(`${origin}/v3/registration/LIBRARY/index.json`, {}, env)).json();
    expect(registration.items[0]).toMatchObject({ lower: "1.2.0", upper: "1.11.0-beta.2", count: 3 });
    expect(registration.items[0].items[2].packageContent).toBe(`${origin}/v3/package/library/1.11.0-beta.2/library.1.11.0-beta.2.nupkg`);

    const index = await (await app.request(`${origin}/v3/index.json`, {}, env)).json();
    expect(index.resources.every((resource: { "@id": string }) => resource["@id"].startsWith(`${origin}/`))).toBe(true);
    expect(models.nugetToken.findUnique).not.toHaveBeenCalled();
  });
  it("preserves security and CORS headers on catalog and content routes", async () => {
    for (const path of ["/v3/index.json", "/v3/registration/library/1.0.0.json", "/v3/files/file"]) {
      const response = await request(path, { headers: { Origin: "https://beutl.example" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const preflight = await request("/v3/files/file", {
      method: "OPTIONS", headers: { Origin: "https://beutl.example", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Range");
  });
  it("includes stable build metadata in version autocomplete", async () => {
    models.package.findFirst.mockResolvedValueOnce({ ...pkg, Release: [
      { ...release, version: "v1.0.0+linux-x64", nugetListed: true },
      { ...release, version: "2.0.0-beta+linux-x64", nugetListed: true },
      { ...release, version: "3.0.0+linux-x64", nugetListed: false },
    ] });
    expect(await (await request("/v3/autocomplete?id=Library&semVerLevel=2.0.0")).json()).toEqual({ data: ["1.0.0"] });
  });
  it.each([undefined, "1.0.0", "2.0.0-beta", "invalid", "2.0.0", "3.0.0"])("honors semVerLevel=%s in search and autocomplete", async (level) => {
    const suffix = level ? `&semVerLevel=${level}` : "";
    const semVer2 = level === "2.0.0" || level === "3.0.0";
    await request(`/v3/search?prerelease=true${suffix}`);
    await request(`/v3/autocomplete?q=Library${suffix}`);
    const where = models.package.count.mock.calls[0][0].where;
    expect(where.Release.some.nugetSemVer2).toBe(semVer2 ? undefined : false);
    expect(models.package.findMany.mock.calls[0][0].where).toEqual(where);
    expect(models.package.count.mock.calls[1][0].where.Release.some.nugetSemVer2).toBe(semVer2 ? undefined : false);
    models.package.findFirst.mockResolvedValueOnce({ ...pkg, Release: [
      { ...release, version: "1.0.0", nugetListed: true },
      { ...release, version: "2.0.0+build", nugetListed: true, nugetSemVer2: true },
      { ...release, version: "3.0.0-beta.1", nugetListed: true, nugetSemVer2: true },
      // A stable package with a SemVer 2 dependency range is also incompatible.
      { ...release, version: "4.0.0", nugetListed: true, nugetSemVer2: true },
    ] });
    expect(await (await request(`/v3/autocomplete?id=Library&prerelease=true${suffix}`)).json()).toEqual({
      data: semVer2 ? ["1.0.0", "2.0.0", "3.0.0-beta.1", "4.0.0"] : ["1.0.0"],
    });
  });
  it.each(["registration", "registration-semver1"])("links bounded %s pages without loading every manifest or reading storage", async (hive) => {
    const releases = Array.from({ length: 130 }, (_, i) => ({ ...release, id: `r${i}`, version: `1.0.${i}` }));
    const catalog = { ...pkg, Release: releases.toReversed() };
    models.package.findFirst.mockResolvedValueOnce(catalog);
    const index = await (await request(`/v3/${hive}/library/index.json`)).json();
    expect(index.count).toBe(3);
    expect(index.items.map((p: { count: number; lower: string; upper: string }) => [p.count, p.lower, p.upper]))
      .toEqual([[64, "1.0.0", "1.0.63"], [64, "1.0.64", "1.0.127"], [2, "1.0.128", "1.0.129"]]);
    expect(index.items.every((p: object) => !("items" in p))).toBe(true);
    expect(index.items.every((p: { "@id": string }) => p["@id"].includes(`/v3/${hive}/`))).toBe(true);
    expect(models.release.findMany).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
    for (const [i, page] of index.items.entries()) {
      models.package.findFirst.mockResolvedValueOnce(catalog);
      models.release.findMany.mockResolvedValueOnce(releases.slice(i * 64, (i + 1) * 64));
      const result = await (await app.request(page["@id"])).json();
      expect(result.count).toBe(page.count);
      expect(result.items.map((item: { catalogEntry: { version: string } }) => item.catalogEntry.version))
        .toEqual(releases.slice(i * 64, (i + 1) * 64).map((r) => r.version));
      expect(result.parent).toBe(index["@id"]);
    }
    const selection = models.release.findMany.mock.calls[0][0];
    expect(selection.where.nugetSemVer2).toBe(hive === "registration-semver1" ? false : undefined);
    expect(models.package.findFirst.mock.calls[0][0].select.Release.where.nugetSemVer2).toBe(hive === "registration-semver1" ? false : undefined);
    expect(selection.where.id.in).toHaveLength(64);
    expect(selection.select).not.toHaveProperty("nuspec");
    expect(selection.select).not.toHaveProperty("readme");
    models.package.findFirst.mockResolvedValueOnce(catalog);
    expect((await request(`/v3/${hive}/library/page/1.0.0/1.0.129.json`)).status).toBe(404);
  });
  it("keeps legacy leaf, dependency and search links in the legacy hive", async () => {
    const metadata = { ...release.nugetMetadata, dependencyGroups: [{ targetFramework: "", dependencies: [{ id: "Dependency", range: "[1.0,2.0)" }] }] };
    models.release.findFirst.mockResolvedValueOnce({ ...release, nugetMetadata: metadata });
    const item = await (await request("/v3/registration-semver1/library/1.0.0.json")).json();
    expect(item["@id"]).toBe("https://nuget.beditor.net/v3/registration-semver1/library/1.0.0.json");
    expect(item.registration).toBe("https://nuget.beditor.net/v3/registration-semver1/library/index.json");
    expect(item.catalogEntry.dependencyGroups[0].dependencies[0].registration)
      .toBe("https://nuget.beditor.net/v3/registration-semver1/dependency/index.json");
    expect(models.release.findFirst.mock.calls[0][0].where.nugetSemVer2).toBe(false);
    models.package.findMany.mockResolvedValueOnce([pkg]);
    const search = await (await request("/v3/search")).json();
    expect(search.data[0]["@id"]).toBe(item.registration);
    expect(search.data[0].versions[0]["@id"]).toBe(item["@id"]);
  });
  it("omits SemVer 2 dependencies discovered during legacy archive extraction", async () => {
    const nuspec = manifest.replace("</metadata>", '<dependencies><dependency id="Dependency" version="[1.0.0-beta.1,2.0)" /></dependencies></metadata>');
    const bytes = zipSync({ "Library.nuspec": strToU8(nuspec) });
    setR2BucketProvider(() => ({ get: async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options!.range!.offset, options!.range!.offset + options!.range!.length).buffer,
    }) }) as never);
    const legacy = { ...release, nugetMetadata: null, nuspec: null, file: { ...release.file, size: BigInt(bytes.length) } } as unknown as typeof release;
    models.release.findMany.mockResolvedValueOnce([legacy]);
    expect((await request("/v3/registration-semver1/library/index.json")).status).toBe(404);
    models.release.findFirst.mockResolvedValueOnce(legacy);
    expect((await request("/v3/registration-semver1/library/1.0.0.json")).status).toBe(404);
    expect(models.release.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nugetSemVer2: true }) }));
  });
  it("parses legacy registration archives sequentially", async () => {
    let active = 0, maximum = 0;
    const releases = ["1.0.0", "2.0.0"].map((version) => {
      const bytes = zipSync({ "Library.nuspec": strToU8(manifest.replace("1.0.0", version)) });
      return { ...release, version, id: version, nugetMetadata: null, nuspec: null,
        file: { ...release.file, objectKey: version, size: BigInt(bytes.length) }, bytes };
    });
    setR2BucketProvider(() => ({ get: async (key, options) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const bytes = releases.find((r) => r.id === key)!.bytes;
      return { arrayBuffer: async () => bytes.slice(options!.range!.offset, options!.range!.offset + options!.range!.length).buffer };
    } }) as never);
    models.package.findFirst.mockResolvedValueOnce({ ...pkg, Release: releases } as unknown as typeof pkg);
    models.release.findMany.mockResolvedValueOnce(releases as unknown as typeof pkg.Release);
    const result = await (await request("/v3/registration/library/index.json")).json();
    expect(result.items[0].count).toBe(2);
    expect(maximum).toBe(1);
    expect(models.release.updateMany).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["invalid ZIP", strToU8("not a ZIP")],
    ["missing manifest", zipSync({ "readme.txt": strToU8("legacy data") })],
    ["mismatched identity", zipSync({ "other.nuspec": strToU8(manifest.replace("<id>Library</id>", "<id>Other</id>")) })],
  ])("isolates a legacy artifact with %s in search and registration", async (_, bytes) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setR2BucketProvider(() => ({ get: async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options?.range?.offset ?? 0,
        (options?.range?.offset ?? 0) + (options?.range?.length ?? bytes.length)).buffer,
    }) }) as never);
    const unreadable = { ...release, id: "unreadable", version: "2.0.0", nugetMetadata: null, nuspec: null,
      file: { ...release.file, size: BigInt(bytes.length) } };
    const mixed = { ...pkg, Release: [unreadable, release] } as typeof pkg;
    models.package.findMany.mockResolvedValueOnce([mixed, { ...pkg, name: "Broken", Release: [unreadable] } as typeof pkg]);
    models.package.count.mockResolvedValueOnce(2);
    const search = await request("/v3/search");
    expect(search.status).toBe(200);
    expect((await search.json()).data).toMatchObject([{ id: "Library", version: "1.0.0", versions: [{ version: "1.0.0" }] }]);
    models.package.findFirst.mockResolvedValueOnce(mixed);
    models.release.findMany.mockResolvedValueOnce(mixed.Release);
    const registration = await request("/v3/registration/library/index.json");
    expect(registration.status).toBe(200);
    expect((await registration.json()).items[0]).toMatchObject({ lower: "1.0.0", upper: "1.0.0", count: 1 });
    models.package.findFirst.mockResolvedValueOnce(mixed);
    models.release.findFirst.mockResolvedValueOnce(unreadable as unknown as typeof release);
    expect((await request("/v3/registration/library/2.0.0.json")).status).toBe(404);
    expect(errors).toHaveBeenCalledWith("Skipping unreadable NuGet release", "unreadable", expect.any(Error));
  });
  it("persists successfully parsed legacy metadata and reuses it on later requests", async () => {
    const bytes = zipSync({ "Library.nuspec": strToU8(manifest) });
    const get = vi.fn(async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }));
    setR2BucketProvider(() => ({ get }) as never);
    const legacy = { ...release, version: "v1.0.0+linux-x64", nugetMetadata: null, nuspec: null,
      file: { ...release.file, size: BigInt(bytes.length) } } as unknown as NugetRelease;
    models.release.updateMany.mockImplementationOnce(async ({ data }: { data: object }) => {
      Object.assign(legacy, data);
      return { count: 1 };
    });
    const parsed = await releaseMetadata(pkg, legacy);
    expect(models.release.updateMany).toHaveBeenCalledWith({
      where: { id: legacy.id, fileId: legacy.fileId, version: legacy.version },
      data: { nugetMetadata: parsed.metadata, nuspec: manifest, readme: null, nugetSemVer2: true },
    });
    const reads = get.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(await releaseMetadata(pkg, legacy)).toEqual(parsed);
    expect(get).toHaveBeenCalledTimes(reads);
  });
  it("keeps identity validation and conflict errors mapped at the API boundary", async () => {
    expect((await request("/v3/package/library/not-a-version/library.nupkg")).status).toBe(400);
    models.package.findFirst.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "P2002" }));
    const conflict = await request("/api/v2/package/library/1.0.0", { method: "POST", headers: { "X-NuGet-ApiKey": secret } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).message).toContain("previously published");
  });
  it("serves HEAD without fetching package bytes", async () => {
    const response = await request("/v3/files/file", { method: "HEAD" });
    expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("4");
    expect(bucket.get).not.toHaveBeenCalled();
    expect(models.release.updateMany).not.toHaveBeenCalled();
  });
  it("still serves a download when the counter write fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("database unavailable");
    models.release.updateMany.mockRejectedValueOnce(failure);
    const response = await request("/v3/files/file");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test");
    expect(errors).toHaveBeenCalledWith("Failed to count NuGet download", "file", failure);
  });
  it("returns bytes before its background database counter settles", async () => {
    const pending = Promise.withResolvers<{ count: number }>();
    models.release.updateMany.mockReturnValueOnce(pending.promise);
    const waitUntil = vi.fn();
    const runWithBackgroundDb = vi.fn((work: () => Promise<unknown>) => work());
    const response = await app.request("https://nuget.test/v3/package/library/1.0.0/library.1.0.0.nupkg", {}, {
      execution: { waitUntil, runWithBackgroundDb },
    });
    expect(await response.text()).toBe("test");
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(runWithBackgroundDb).toHaveBeenCalledOnce();
    pending.resolve({ count: 1 });
    await waitUntil.mock.calls[0][0];
  });
  it.each(["DELETE", "POST"])("reindexes the highest listed SDK metadata after %s", async (method) => {
    const updated = { ...release, id: "latest", version: "2.0.0", nugetListed: method === "DELETE",
      nugetMetadata: { ...release.nugetMetadata, title: "Latest", description: "Latest searchable term", tags: ["latest"] } };
    const catalog = { ...pkg, Release: [{ ...release, nugetListed: true }, updated] };
    models.package.findFirst.mockResolvedValueOnce(catalog);
    models.publishedPackageVersion.upsert.mockResolvedValueOnce({ releaseId: "latest" });
    const response = await request("/api/v2/package/library/2.0.0", { method, headers: { "X-NuGet-ApiKey": secret } });
    expect(response.status).toBe(method === "DELETE" ? 204 : 200);
    const expected = method === "DELETE" ? release.nugetMetadata : updated.nugetMetadata;
    expect(models.package.update).toHaveBeenCalledWith({ where: { id: "pkg" }, data: expect.objectContaining({
      displayName: expected.title, description: expected.description, tags: expected.tags,
    }) });
  });
  it("preserves user package editorial metadata when listing changes", async () => {
    models.package.findFirst.mockResolvedValueOnce({ ...pkg, audience: "USER" });
    await request("/api/v2/package/library/1.0.0", { method: "POST", headers: { "X-NuGet-ApiKey": secret } });
    expect(models.package.update).not.toHaveBeenCalled();
  });
  it.each(["/api/v2/package", "/api/v2/package/"])("authenticates %s before reading its request body", async (path) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull() { throw new Error("must not read"); }, cancel }, { highWaterMark: 0 });
    const response = await request(path, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(401); expect(cancel).toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it("requires a push scope and ownership to unlist and never deletes bytes", async () => {
    canPush = false;
    expect((await request("/api/v2/package/library/1.0.0", { method: "DELETE", headers: { "X-NuGet-ApiKey": secret } })).status).toBe(403);
    canPush = true; buyer = "other";
    expect((await request("/api/v2/package/library/1.0.0", { method: "DELETE", headers: { "X-NuGet-ApiKey": secret } })).status).toBe(403);
    buyer = null;
    expect((await request("/api/v2/package/library/1.0.0", { method: "DELETE", headers: { "X-NuGet-ApiKey": secret } })).status).toBe(204);
    expect(models.release.update).toHaveBeenCalledWith({ where: { id: "release" }, data: { nugetListed: false, artifactLocked: true } });
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it.each(["DELETE", "POST"])("requires authentication and push scope for %s listing changes", async (method) => {
    expect((await request("/api/v2/package/library/1.0.0", { method })).status).toBe(401);
    canPush = false;
    expect((await request("/api/v2/package/library/1.0.0", {
      method, headers: { "X-NuGet-ApiKey": secret },
    })).status).toBe(403);
    expect(models.release.update).not.toHaveBeenCalled();
  });
  it("enforces purchase access for user packages on canonical downloads", async () => {
    paid = true;
    expect((await request("/v3/package/library/1.0.0/library.1.0.0.nupkg")).status).toBe(401);
    buyer = "other";
    const headers = { authorization: `Basic ${btoa(`unused:${secret}`)}` };
    expect((await request("/v3/files/file", { headers })).status).toBe(403);
    buyer = "buyer";
    expect((await request("/v3/files/file", { headers })).status).toBe(200);
    revoked = true;
    expect((await request("/v3/files/file", { headers })).status).toBe(401);
  });
  it("binds Web tickets to one file and rechecks paid access", async () => {
    paid = true; buyer = "buyer";
    const url = await nugetFileUrl("file", "buyer");
    const ticket = new URL(url).searchParams.get("ticket")!;
    expect(await verifyDownloadTicket(ticket, "other-file")).toBeNull();
    expect((await app.request(url)).status).toBe(200);
    buyer = null;
    expect((await app.request(url)).status).toBe(403);
  });
  it("rejects malformed tickets without concealing missing signing configuration", async () => {
    expect(await verifyDownloadTicket("not-a-ticket", "file")).toBeNull();
    vi.stubEnv("NUGET_DOWNLOAD_SECRET", "");
    await expect(verifyDownloadTicket("not-a-ticket", "file")).rejects.toThrow("not configured");
  });
});
