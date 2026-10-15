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
  package: { findFirst: vi.fn(async () => pkg), findUniqueOrThrow: vi.fn(async () => pkg), findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
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
  });
  it("serves HEAD without fetching package bytes", async () => {
    const response = await request("/v3/files/file", { method: "HEAD" });
    expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("4");
    expect(bucket.get).not.toHaveBeenCalled();
  });
  it("authenticates pushes before reading their request body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull() { throw new Error("must not read"); }, cancel }, { highWaterMark: 0 });
    const response = await request("/api/v2/package/", { method: "PUT", body: stream, duplex: "half" } as RequestInit);
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
