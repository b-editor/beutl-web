import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import app from "../../packages/api/src/nuget/app";
import { parseNuspec } from "../../packages/api/src/nuget/archive";
import { nugetFileUrl, verifyDownloadTicket } from "../../packages/api/src/nuget/tickets";

const secret = `bn_${"a".repeat(64)}`;
const manifest = '<package><metadata><id>Library</id><version>1.0.0</version><authors>Author</authors><description>Library</description></metadata></package>';
const release = { id: "release", packageId: "pkg", version: "1.0.0", published: true, artifactLocked: true, nugetListed: false,
  fileId: "file", file: { id: "file", objectKey: "object", size: 4n }, downloads: 0n, createdAt: new Date("2026-01-01"),
  nugetMetadata: parseNuspec(manifest), nuspec: manifest, readme: null };
const pkg = { id: "pkg", name: "Library", audience: "DEVELOPMENT", userId: "owner", published: true, Release: [release] };
let paid = false, buyer: string | null = null, revoked = false, canPush = true;
const file = () => ({ name: "library.nupkg", size: 4n, objectKey: "object", sha256: "abc", userId: "owner", visibility: "DEDICATED",
  Package: [], Profile: [], PackageScreenshot: [], aiJobResult: null,
  Release: [{ published: true, package: { ...pkg, packagePricing: paid ? [{ id: "price", price: 100 }] : [] } }] });
const models = {
  package: { findFirst: vi.fn(async () => pkg), findUniqueOrThrow: vi.fn(async () => pkg), findMany: vi.fn(async () => [] as (typeof pkg)[]), count: vi.fn(async () => 0) },
  release: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => release) },
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
  vi.stubEnv("NUGET_DOWNLOAD_SECRET", "nuget-test-download-secret");
  setDbProvider(async () => ({ ...models, $transaction: async (fn: (tx: unknown) => unknown) => fn(models) }) as never);
  setR2BucketProvider(() => bucket);
});
afterEach(() => vi.unstubAllEnvs());

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
    const search = await app.request(`${origin}/v3/search?q=Library&skip=4&take=8&prerelease=true`, {}, env);
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
});
