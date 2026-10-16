import { Hono } from "hono";
import { sign } from "hono/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import packages from "../../packages/api/src/v3/packages";
import library from "../../packages/api/src/v3/library";
import nuget from "../../packages/api/src/nuget/app";
import { verifyDownloadTicket } from "../../packages/api/src/nuget/tickets";

const api = new Hono().route("/packages", packages).route("/library", library);
const origin = "https://nuget.staging.test";
let paid: boolean, purchased: boolean, published: boolean;
const release = { id: "release", version: "1.0.0", title: "Release", description: "", targetVersion: "1.0.0", fileId: "file" };
const pkg = () => ({ id: "pkg", name: "Library", audience: "USER", userId: "owner", published,
  displayName: "Library", shortDescription: "", tags: [], iconFileId: null, user: { Profile: null },
  packagePricing: paid ? [{ id: "price", price: 100, currency: "USD", fallback: true }] : [],
  Release: [{ ...release, published }] });

beforeEach(() => {
  paid = true; purchased = true; published = true;
  vi.stubEnv("JWT_SECRET", "test-api-secret");
  vi.stubEnv("JWT_ISSUER", "");
  vi.stubEnv("JWT_AUDIENCE", "");
  vi.stubEnv("NUGET_DOWNLOAD_SECRET", "test-download-secret");
  vi.stubEnv("NUGET_PUBLIC_ORIGIN", origin);
  setDbProvider(async () => ({
    package: { findFirst: async () => pkg() },
    release: { findFirst: async () => ({ ...release, published }), findMany: async () => [{ ...release, published }], updateMany: async () => ({ count: 1 }) },
    file: { findFirst: async () => ({ id: "file", name: "Library.nupkg", size: 4n, objectKey: "object", userId: "owner", visibility: "DEDICATED",
      Package: [], Profile: [], PackageScreenshot: [], Release: [{ published, package: pkg() }] }) },
    user: { findUnique: async () => ({ id: "buyer" }) },
    userPackage: { findMany: async () => [{ packageId: "pkg" }], findFirst: async () => ({ id: "acquired" }), count: async () => 1 },
    packagePricing: { findFirst: async () => paid ? { id: "price" } : null },
    userPaymentHistory: { findFirst: async ({ where }: { where: { userId: string } }) =>
      purchased && where.userId === "buyer" ? { id: "purchase" } : null },
  }) as never);
  setR2BucketProvider(() => ({ get: async () => ({ body: new Blob(["test"]).stream() }) }) as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fileUrl(endpoint: string, userId: string | null) {
  const headers = new Headers();
  if (userId) headers.set("Authorization", `Bearer ${await sign({
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId,
    exp: Math.floor(Date.now() / 1000) + 300,
  }, "test-api-secret", "HS256")}`);
  const acquire = endpoint === "acquire";
  if (acquire) headers.set("Content-Type", "application/json");
  const response = await api.request(endpoint === "library" || acquire ? "/library" : `/packages/Library/${endpoint}`, {
    method: acquire ? "POST" : "GET", headers, ...(acquire ? { body: JSON.stringify({ packageId: "pkg" }) } : {}),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const result = await response.json();
  const url = new URL(endpoint === "library" ? result[0].latestRelease.fileUrl
    : acquire ? result.latestRelease.fileUrl : endpoint === "releases" ? result[0].fileUrl : result.fileUrl);
  expect(url.origin).toBe(origin);
  if (userId) expect(await verifyDownloadTicket(url.searchParams.get("ticket")!, "file")).toBe(userId);
  else expect(url.searchParams.has("ticket")).toBe(false);
  return url.toString();
}

describe("API release links across the NuGet origin", () => {
  it.each(["releases", "releases/1.0.0", "library", "acquire"])("preserves purchaser identity from %s without forwarding Authorization", async (endpoint) => {
    const url = await fileUrl(endpoint, "buyer");
    const response = await nuget.request(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test");
    purchased = false;
    expect((await nuget.request(url)).status).toBe(403);
  });
  it.each(["releases", "releases/1.0.0"])("preserves unpublished owner access from %s", async (endpoint) => {
    published = false;
    expect((await nuget.request(await fileUrl(endpoint, "owner"))).status).toBe(200);
  });
  it.each(["releases", "releases/1.0.0"])("keeps free downloads from %s anonymous", async (endpoint) => {
    paid = false;
    expect((await nuget.request(await fileUrl(endpoint, null))).status).toBe(200);
  });
});
