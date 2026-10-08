import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { contentEntityTag } from "../../apps/web/src/lib/content-cache";

const mocks = vi.hoisted(() => ({
  findFileForContentAccess: vi.fn(),
  existsUserPaymentHistory: vi.fn(),
  getSession: vi.fn(),
  tryGetUserIdFromHeaders: vi.fn(),
  getCloudflareContext: vi.fn(),
  get: vi.fn(),
  open: vi.fn(),
  match: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  findFileForContentAccess: mocks.findFileForContentAccess,
  existsUserPaymentHistory: mocks.existsUserPaymentHistory,
}));
vi.mock("@beutl/api", () => ({ tryGetUserIdFromHeaders: mocks.tryGetUserIdFromHeaders }));
vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
// This dependency belongs to apps/web; mocking a bare import from the root
// tests would register a different module ID from the route's resolved import.
vi.mock("../../apps/web/node_modules/@opennextjs/cloudflare/dist/api/index.js", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

type ContentGet = typeof import("../../apps/web/src/app/api/contents/[fileId]/route").GET;
let GET: ContentGet;
beforeAll(async () => {
  setR2BucketProvider(() => ({ get: mocks.get }) as never);
  ({ GET } = await import("../../apps/web/src/app/api/contents/[fileId]/route"));
});

const BYTES = new Uint8Array([1, 2, 3, 4]);
const SHA256 = "a".repeat(64);
const file = () => ({
  name: "image.png",
  objectKey: "objects/image-1",
  visibility: "PUBLIC" as "PUBLIC" | "PRIVATE" | "DEDICATED",
  userId: "owner",
  mimeType: "image/png",
  size: BigInt(BYTES.byteLength),
  sha256: SHA256 as string | null,
  Package: [] as { userId: string; published: boolean }[],
  Profile: [],
  PackageScreenshot: [],
  Release: [] as {
    published: boolean;
    package: { id: string; userId: string; published: boolean; packagePricing: { id: string; price: number }[] };
  }[],
});
let pending: Promise<unknown>[];
let stored: Map<string, Response>;

async function request(headers?: HeadersInit, query = "") {
  return GET(
    new Request(`https://beutl.example/api/contents/file-1${query}`, { headers }) as Parameters<ContentGet>[0],
    { params: Promise.resolve({ fileId: "file-1" }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  pending = [];
  stored = new Map();
  vi.stubGlobal("caches", { open: mocks.open });
  mocks.open.mockResolvedValue({ match: mocks.match, put: mocks.put });
  mocks.match.mockImplementation(async (key: Request) => stored.get(key.url)?.clone());
  mocks.put.mockImplementation(async (key: Request, response: Response) => {
    stored.set(key.url, new Response(await response.arrayBuffer(), { headers: response.headers }));
  });
  mocks.getCloudflareContext.mockReturnValue({ ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) } });
  mocks.findFileForContentAccess.mockResolvedValue(file());
  mocks.getSession.mockResolvedValue(null);
  mocks.tryGetUserIdFromHeaders.mockResolvedValue(null);
  mocks.existsUserPaymentHistory.mockResolvedValue(false);
  mocks.get.mockImplementation(async () => ({
    body: new Response(BYTES).body,
    size: BYTES.byteLength,
  }));
});

afterEach(async () => {
  await Promise.all(pending);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("image delivery", () => {
  it("skips session and token lookups for public images", async () => {
    expect((await request({ Cookie: "session=unused", Authorization: "Bearer unused" })).status).toBe(200);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.tryGetUserIdFromHeaders).not.toHaveBeenCalled();
    expect(mocks.existsUserPaymentHistory).not.toHaveBeenCalled();
  });

  it("reuses cached bytes across requests while rebuilding current metadata", async () => {
    const first = await request({ Cookie: "session=unused", Authorization: "Bearer unused" }, "?ignored=1");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(BYTES);
    await Promise.all(pending);
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), name: "renamed.png" });
    const second = await request(undefined, "?ignored=2");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(BYTES);
    expect(second.headers.get("Content-Disposition")).toContain("renamed.png");
    expect(second.headers.get("Cache-Control")).toBe("public, no-cache, must-revalidate");
    expect(second.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.findFileForContentAccess).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith("beutl-image-content-v1");
    const [key, response] = mocks.put.mock.calls[0] as [Request, Response];
    expect([...key.headers]).toEqual([]);
    expect(key.url).not.toContain("ignored");
    expect([...response.headers]).toEqual([
      ["cache-control", "public, max-age=86400"],
      ["content-length", "4"],
      ["content-type", "application/octet-stream"],
    ]);
  });

  it("never lets a cached public image bypass a later unpublish or deletion", async () => {
    await (await request()).arrayBuffer();
    await Promise.all(pending);
    const unpublished = {
      ...file(), visibility: "DEDICATED", Package: [{ userId: "owner", published: false }],
    };
    for (const record of [unpublished, null]) {
      mocks.findFileForContentAccess.mockResolvedValue(record);
      const response = await request({ "If-None-Match": contentEntityTag(file()) });
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(mocks.match).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("reuses private bytes only after authenticating the owner on every request", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request({ "If-None-Match": contentEntityTag(file()) });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
      await Promise.all(pending);
    }
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    mocks.getSession.mockResolvedValue({ user: { id: "other-user" } });
    expect((await request()).status).toBe(404);
    expect(mocks.match).toHaveBeenCalledTimes(2);
  });

  it("still accepts a desktop token for a private image", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.tryGetUserIdFromHeaders.mockResolvedValue("owner");
    expect((await request({ Authorization: "Bearer desktop-token" })).status).toBe(200);
    expect(mocks.tryGetUserIdFromHeaders).toHaveBeenCalledTimes(1);
  });

  it("checks a paid release purchase again before reusing its image bytes", async () => {
    const paid = {
      ...file(), visibility: "DEDICATED",
      Release: [{ published: true, package: {
        id: "package-1", userId: "owner", published: true, packagePricing: [{ id: "price-1", price: 100 }],
      } }],
    };
    mocks.findFileForContentAccess.mockResolvedValue(paid);
    mocks.getSession.mockResolvedValue({ user: { id: "purchaser" } });
    mocks.existsUserPaymentHistory.mockResolvedValue(true);
    expect((await request()).status).toBe(200);
    await Promise.all(pending);
    mocks.existsUserPaymentHistory.mockResolvedValue(false);
    const refused = await request({ "If-None-Match": contentEntityTag(file()) });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.existsUserPaymentHistory).toHaveBeenCalledTimes(2);
    expect(mocks.match).toHaveBeenCalledTimes(1);
  });

  it.each([`"sha256-${SHA256}"`, `"other", W/"sha256-${SHA256}"`, "*"])(
    "revalidates public bytes without reading storage for %s", async (validator) => {
      const response = await request({ "If-None-Match": validator });
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("ETag")).toBe(`"sha256-${SHA256}"`);
      expect(response.headers.get("Cache-Control")).toBe("public, no-cache, must-revalidate");
      expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.match).not.toHaveBeenCalled();
    },
  );

  it("returns the whole image for a stale validator or If-Range", async () => {
    const response = await request({ "If-None-Match": '"old"', Range: "bytes=0-1", "If-Range": '"old"' });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(mocks.get).toHaveBeenCalledWith("objects/image-1", undefined);
  });

  it("does not use or populate the whole-image cache for byte ranges", async () => {
    mocks.get.mockResolvedValue({ body: new Response(BYTES.slice(0, 2)).body, size: 4 });
    const response = await request({ Range: "bytes=0-1", "If-Range": contentEntityTag(file()) });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(0, 2));
    expect(response.headers.get("Content-Range")).toBe("bytes 0-1/4");
    expect(mocks.get).toHaveBeenCalledWith("objects/image-1", { range: { offset: 0, length: 2 } });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("revalidates legacy objects with a weak tag without hashing their bodies", async () => {
    const legacy = { ...file(), sha256: null };
    mocks.findFileForContentAccess.mockResolvedValue(legacy);
    expect((await request({ "If-None-Match": contentEntityTag(legacy).replace("W/", "") })).status).toBe(304);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("does not reuse an old cache entry after the underlying object changes", async () => {
    await (await request()).arrayBuffer();
    await Promise.all(pending);
    const changed = { ...file(), objectKey: "objects/image-2", sha256: "b".repeat(64) };
    mocks.findFileForContentAccess.mockResolvedValue(changed);
    const response = await request({ "If-None-Match": contentEntityTag(file()) });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(contentEntityTag(changed));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it.each(["text/html", "image/svg+xml", "video/mp4"])("streams %s without image caching", async (mimeType) => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), mimeType });
    expect((await request()).status).toBe(200);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("streams large images without cloning or buffering their bodies", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), size: BigInt(20 * 1024 * 1024) });
    const arrayBuffer = vi.fn();
    mocks.get.mockResolvedValue({ body: new Response(BYTES).body, arrayBuffer });
    const response = await request();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("still streams images outside a Cloudflare execution context", async () => {
    mocks.getCloudflareContext.mockImplementation(() => { throw new Error("no Worker context"); });
    expect((await request()).status).toBe(200);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each(["open", "match", "put"] as const)("keeps delivering an image when cache %s fails", async (operation) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks[operation].mockRejectedValue(new Error("cache unavailable"));
    const response = await request();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    await Promise.all(pending);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("does not block the response on a pending cache write", async () => {
    let finish: () => void;
    const write = new Promise<void>((resolve) => { finish = resolve; });
    mocks.put.mockReturnValue(write);
    try {
      const response = await request();
      expect(response.status).toBe(200);
      expect(pending).toHaveLength(1);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    } finally {
      finish!();
    }
  });
});
