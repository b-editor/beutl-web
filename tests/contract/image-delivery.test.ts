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
  input: vi.fn(),
  transform: vi.fn(),
  output: vi.fn(),
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
let HEAD: ContentGet;
beforeAll(async () => {
  setR2BucketProvider(() => ({ get: mocks.get }) as never);
  ({ GET, HEAD } = await import("../../apps/web/src/app/api/contents/[fileId]/route"));
});

const BYTES = new Uint8Array([1, 2, 3, 4]);
const WEBP_BYTES = new Uint8Array([5, 6]);
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

async function head(headers?: HeadersInit, query = "") {
  return HEAD(
    new Request(`https://beutl.example/api/contents/file-1${query}`, { method: "HEAD", headers }) as Parameters<ContentGet>[0],
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
  mocks.getCloudflareContext.mockReturnValue({
    env: { IMAGES: { input: mocks.input }, BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED: "true" },
    ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) },
  });
  mocks.input.mockReturnValue({ transform: mocks.transform });
  mocks.transform.mockReturnValue({ output: mocks.output });
  mocks.output.mockImplementation(async () => ({ response: () => new Response(WEBP_BYTES) }));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("image delivery", () => {
  it.each(["PUBLIC", "PRIVATE"] as const)("HEAD matches cached WebP GET metadata for %s images without encoding", async (visibility) => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    const get = await request(undefined, "?image=preview-1024");
    await get.arrayBuffer();
    await Promise.all(pending);
    const response = await head(undefined, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    for (const name of ["Content-Type", "ETag", "Content-Length", "Content-Disposition", "Accept-Ranges", "Cache-Control", "Vary"]) {
      expect(response.headers.get(name)).toBe(get.headers.get(name));
    }
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const conditional = await head({ "If-None-Match": get.headers.get("ETag")! }, "?image=preview-1024");
    expect(conditional.status).toBe(visibility === "PUBLIC" ? 304 : 200);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("omits uncertain encoding metadata on cold HEAD without fetching or transforming bytes", async () => {
    const response = await head(undefined, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    for (const name of ["Content-Type", "Content-Length", "ETag", "Content-Disposition", "Accept-Ranges"]) {
      expect(response.headers.get(name)).toBeNull();
    }
    expect(response.headers.get("Cache-Control")).toBe("public, no-cache, must-revalidate");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.input).not.toHaveBeenCalled();
  });

  it("HEAD advertises and revalidates the original during a known quota pause", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue({ code: 9422 });
    const get = await request(undefined, "?image=preview-1024");
    await get.arrayBuffer();
    await Promise.all(pending);
    const response = await head(undefined, "?image=preview-1024");
    expect(await response.text()).toBe("");
    for (const name of ["Content-Type", "ETag", "Content-Length", "Accept-Ranges"]) {
      expect(response.headers.get(name)).toBe(get.headers.get(name));
    }
    expect((await head({ "If-None-Match": get.headers.get("ETag")! }, "?image=preview-1024")).status).toBe(304);
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("HEAD still describes an already cached variant while other transformations are paused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = await request(undefined, "?image=icon-64");
    await get.arrayBuffer();
    await Promise.all(pending);
    mocks.output.mockRejectedValue({ code: 9422 });
    await (await request(undefined, "?image=icon-128")).arrayBuffer();
    const response = await head(undefined, "?image=icon-64");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Length")).toBe("2");
    expect(response.headers.get("ETag")).toBe(get.headers.get("ETag"));
    expect((await head({ "If-None-Match": get.headers.get("ETag")! }, "?image=icon-64")).status).toBe(304);
    expect((await request({ "If-None-Match": get.headers.get("ETag")! }, "?image=icon-64")).status).toBe(304);
    expect(mocks.input).toHaveBeenCalledTimes(2);
  });

  it("HEAD checks current private ownership before reading cached metadata", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    await (await request(undefined, "?image=icon-64")).arrayBuffer();
    await Promise.all(pending);
    mocks.getSession.mockResolvedValue({ user: { id: "other" } });
    const response = await head(undefined, "?image=icon-64");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.match).toHaveBeenCalledTimes(2);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("HEAD ignores byte ranges and returns full cached-variant metadata", async () => {
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    const response = await head({ Range: "bytes=0-1" }, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Length")).toBe("2");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("");
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("HEAD and GET serve AVIF originals without attempting Enterprise-only decoding", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), name: "image.avif", mimeType: "image/avif" });
    const response = await head(undefined, "?image=preview-1024");
    expect(response.headers.get("Content-Type")).toBe("image/avif");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.get).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) {
      expect(new Uint8Array(await (await request(undefined, "?image=preview-1024")).arrayBuffer())).toEqual(BYTES);
      await Promise.all(pending);
    }
    expect(mocks.input).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("revalidates the original after transient transformation failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.output.mockRejectedValue(new Error("Images temporarily unavailable"));
    const first = await request(undefined, "?image=preview-1024");
    await first.arrayBuffer();
    await Promise.all(pending);
    const response = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=preview-1024");
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.output).toHaveBeenCalledTimes(2);
  });

  it("revalidates the original after a public variant falls back at the free quota", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue({ code: 9422 });
    const first = await request(undefined, "?image=preview-1024");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(BYTES);
    await Promise.all(pending);
    const second = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=preview-1024");
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(await second.text()).toBe("");
    expect(mocks.output).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("revalidates a paused original without fetching storage when its byte cache is gone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue({ code: 9422 });
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    stored.clear();
    const response = await request({ "If-None-Match": contentEntityTag(file()) }, "?image=preview-1024");
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("still sends an authenticated private original in full when transformations fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    mocks.output.mockRejectedValue(new Error("Images temporarily unavailable"));
    const response = await request({ "If-None-Match": contentEntityTag(file()) }, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([undefined, "false", "1", "TRUE"])("never calls the transformation service without explicit free-plan activation: %s", async (flag) => {
    mocks.getCloudflareContext.mockReturnValue({
      env: { IMAGES: { input: mocks.input }, BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED: flag },
      ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) },
    });
    const response = await request(undefined, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.input).not.toHaveBeenCalled();
  });

  it("serves the authenticated original when the Images Free quota is exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    mocks.output.mockRejectedValue(new Error("ERROR 9422: Image transformation usage limit reached"));
    const response = await request(undefined, "?image=preview-1024");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect((mocks.put.mock.calls[0][0] as Request).url).not.toContain("variant");

    mocks.getSession.mockResolvedValue({ user: { id: "other-user" } });
    expect((await request(undefined, "?image=preview-1024")).status).toBe(404);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("backs off quota failures across sources and presets, then recovers after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue(new Error("IMAGES_TRANSFORM_ERROR: ERROR 9422: usage limit reached"));
    expect(new Uint8Array(await (await request(undefined, "?image=preview-1024")).arrayBuffer())).toEqual(BYTES);
    await Promise.all(pending);
    expect(new Uint8Array(await (await request(undefined, "?image=thumbnail-320")).arrayBuffer())).toEqual(BYTES);
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), objectKey: "objects/other-image", sha256: "b".repeat(64) });
    vi.setSystemTime(new Date("2026-10-09T00:04:59Z"));
    expect(new Uint8Array(await (await request(undefined, "?image=icon-64")).arrayBuffer())).toEqual(BYTES);
    expect(mocks.output).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-09T00:05:00Z"));
    mocks.output.mockImplementation(async () => ({ response: () => new Response(WEBP_BYTES) }));
    const recovered = await request(undefined, "?image=preview-2048");
    expect(recovered.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(mocks.output).toHaveBeenCalledTimes(2);
    await Promise.all(pending);
    expect(new Uint8Array(await (await request(undefined, "?image=thumbnail-640")).arrayBuffer())).toEqual(WEBP_BYTES);
    expect(mocks.output).toHaveBeenCalledTimes(3);
  });

  it("permits only one recovery probe while concurrent previews use originals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue({ code: 9422 });
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    vi.setSystemTime(new Date("2026-10-09T00:05:00Z"));
    let complete!: (result: { response(): Response }) => void;
    mocks.output.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const probe = request(undefined, "?image=preview-1024");
    await vi.waitFor(() => expect(mocks.output).toHaveBeenCalledTimes(2));
    const concurrent = await request(undefined, "?image=thumbnail-320");
    expect(new Uint8Array(await concurrent.arrayBuffer())).toEqual(BYTES);
    expect(mocks.output).toHaveBeenCalledTimes(2);
    complete({ response: () => new Response(WEBP_BYTES) });
    expect(new Uint8Array(await (await probe).arrayBuffer())).toEqual(WEBP_BYTES);
  });

  it("keeps serving cached variants during the quota backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await (await request(undefined, "?image=icon-64")).arrayBuffer();
    await Promise.all(pending);
    mocks.output.mockRejectedValue(new Error("ERROR 9422: usage limit reached"));
    await (await request(undefined, "?image=icon-128")).arrayBuffer();
    const cached = await request(undefined, "?image=icon-64");
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(cached.headers.get("Content-Type")).toBe("image/webp");
    expect(mocks.output).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: "9422" },
    new Error("binding request failed", { cause: { code: 9422 } }),
  ])("recognizes structured and wrapped quota errors", async (error) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue(error);
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    await (await request(undefined, "?image=thumbnail-320")).arrayBuffer();
    expect(mocks.output).toHaveBeenCalledTimes(1);
  });

  it("renews the pause when a recovery probe still reaches the quota", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue({ code: 9422 });
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    vi.setSystemTime(new Date("2026-10-09T00:05:00Z"));
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    vi.setSystemTime(new Date("2026-10-09T00:09:59Z"));
    await (await request(undefined, "?image=thumbnail-320")).arrayBuffer();
    expect(mocks.output).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not turn invalid-image errors into an account-wide quota pause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.output.mockRejectedValue(new Error("ERROR 9412: input is not a valid image"));
    await (await request(undefined, "?image=preview-1024")).arrayBuffer();
    await Promise.all(pending);
    await (await request(undefined, "?image=thumbnail-320")).arrayBuffer();
    expect(mocks.output).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("delivers and reuses a resized public icon while checking live metadata", async () => {
    const first = await request({ "If-None-Match": contentEntityTag(file()) }, "?image=icon-64&ignored=1");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(first.headers.get("Content-Type")).toBe("image/webp");
    expect(first.headers.get("Content-Disposition")).toContain("image.webp");
    expect(first.headers.get("Content-Length")).toBe("2");
    expect(first.headers.get("Accept-Ranges")).toBe("none");
    expect(first.headers.get("ETag")).toMatch(/^W\/"sha256-.*-webp-q85-v1-icon-64"$/u);
    expect(mocks.transform).toHaveBeenCalledWith({ width: 64, height: 64, fit: "scale-down" });
    expect(mocks.output).toHaveBeenCalledWith({ format: "image/webp", quality: 85 });
    await Promise.all(pending);

    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), name: "renamed.png" });
    const second = await request({ Cookie: "session=unused" }, "?image=icon-64&ignored=2");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(second.headers.get("Content-Disposition")).toContain("renamed.webp");
    expect(second.headers.get("Cache-Control")).toBe("public, no-cache, must-revalidate");
    expect(mocks.findFileForContentAccess).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).not.toHaveBeenCalled();

    const original = await request();
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(BYTES);
    expect(original.headers.get("Content-Type")).toBe("image/png");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("keeps each size and source replacement separate and revalidates the selected representation", async () => {
    const small = await request(undefined, "?image=icon-64");
    await small.arrayBuffer();
    await Promise.all(pending);
    const large = await request({ "If-None-Match": small.headers.get("ETag")! }, "?image=icon-128");
    expect(large.status).toBe(200);
    expect(large.headers.get("ETag")).not.toBe(small.headers.get("ETag"));
    await large.arrayBuffer();
    await Promise.all(pending);
    expect(mocks.input).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    const revalidated = await request({ "If-None-Match": large.headers.get("ETag")! }, "?image=icon-128");
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("Content-Type")).toBe("image/webp");
    expect(mocks.input).toHaveBeenCalledTimes(2);
    expect(mocks.match).toHaveBeenCalledTimes(4);

    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), objectKey: "objects/image-2", sha256: "b".repeat(64) });
    const replaced = await request({ "If-None-Match": large.headers.get("ETag")! }, "?image=icon-128");
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("ETag")).not.toBe(large.headers.get("ETag"));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.input).toHaveBeenCalledTimes(3);
  });

  it("checks unpublishing and deletion before serving cached transformed bytes or 304", async () => {
    const first = await request(undefined, "?image=screenshot-320");
    await first.arrayBuffer();
    await Promise.all(pending);
    for (const record of [
      { ...file(), visibility: "DEDICATED", Package: [{ userId: "owner", published: false }] },
      null,
    ]) {
      mocks.findFileForContentAccess.mockResolvedValue(record);
      const denied = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=screenshot-320");
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(mocks.match).toHaveBeenCalledTimes(2);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it.each(["thumbnail-320", "preview-1024"])("reuses %s only after authenticating its owner on every request", async (preset) => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    const first = await request({ Cookie: "session=owner" }, `?image=${preset}`);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Vary")).toBe("Cookie, Authorization");
    await Promise.all(pending);

    const second = await request({ "If-None-Match": first.headers.get("ETag")! }, `?image=${preset}`);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.findFileForContentAccess).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);

    // Downloads and editing inputs still use the unmodified original URL.
    const original = await request();
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(BYTES);
    expect(original.headers.get("Content-Type")).toBe("image/png");
    expect(original.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);

    for (const session of [null, { user: { id: "other-user" } }]) {
      mocks.getSession.mockResolvedValue(session);
      const denied = await request({ "If-None-Match": first.headers.get("ETag")! }, `?image=${preset}`);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(mocks.match).toHaveBeenCalledTimes(4);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("requires the current purchase before reusing a transformed paid image", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({
      ...file(), visibility: "DEDICATED", Release: [{ published: true, package: {
        id: "package-1", userId: "owner", published: true, packagePricing: [{ id: "price-1", price: 100 }],
      } }],
    });
    mocks.getSession.mockResolvedValue({ user: { id: "purchaser" } });
    mocks.existsUserPaymentHistory.mockResolvedValue(true);
    const first = await request(undefined, "?image=preview-1024");
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    await Promise.all(pending);
    const second = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=preview-1024");
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.input).toHaveBeenCalledTimes(1);

    mocks.existsUserPaymentHistory.mockResolvedValue(false);
    const denied = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=preview-1024");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.existsUserPaymentHistory).toHaveBeenCalledTimes(3);
    expect(mocks.match).toHaveBeenCalledTimes(3);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("authenticates a desktop token before serving a private thumbnail", async () => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    mocks.tryGetUserIdFromHeaders.mockResolvedValue("owner");
    const response = await request({ Authorization: "Bearer desktop-token" }, "?image=thumbnail-320");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.tryGetUserIdFromHeaders).toHaveBeenCalledTimes(1);
    expect(mocks.input).toHaveBeenCalledTimes(1);
  });

  it("rechecks a public image becoming private before accessing its transformed cache", async () => {
    const first = await request(undefined, "?image=thumbnail-320");
    await first.arrayBuffer();
    await Promise.all(pending);
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), visibility: "PRIVATE" });
    const denied = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=thumbnail-320");
    expect(denied.status).toBe(404);
    expect(mocks.match).toHaveBeenCalledTimes(2);

    mocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    const allowed = await request({ "If-None-Match": first.headers.get("ETag")! }, "?image=thumbnail-320");
    expect(allowed.status).toBe(200);
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.input).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["thumbnail-320", 320], ["thumbnail-640", 640],
    ["preview-1024", 1024], ["preview-2048", 2048],
  ])("bounds %s to %s pixels without upscaling", async (preset, size) => {
    const response = await request(undefined, `?image=${preset}`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP_BYTES);
    expect(mocks.transform).toHaveBeenCalledWith({ width: size, height: size, fit: "scale-down" });
    expect(mocks.output).toHaveBeenCalledWith({ format: "image/webp", quality: 85 });
  });

  it.each([
    { query: "?image=icon-999", mimeType: "image/png", size: BigInt(4) },
    { query: "?image=constructor", mimeType: "image/png", size: BigInt(4) },
    { query: "?image=icon-64", mimeType: "image/svg+xml", size: BigInt(4) },
    { query: "?image=icon-64", mimeType: "image/gif", size: BigInt(4) },
    { query: "?image=icon-64", mimeType: "image/avif", size: BigInt(4) },
    { query: "?image=icon-64", mimeType: "image/png", size: BigInt(11 * 1024 * 1024) },
  ])("uses original delivery for unsupported variants or sources: $query $mimeType $size", async ({ query, mimeType, size }) => {
    mocks.findFileForContentAccess.mockResolvedValue({ ...file(), mimeType, size });
    const response = await request(undefined, query);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.input).not.toHaveBeenCalled();
  });

  it("retains original byte-range semantics when an image preset is present", async () => {
    mocks.get.mockResolvedValue({ body: new Response(BYTES.slice(0, 2)).body, size: 4 });
    const response = await request({ Range: "bytes=0-1" }, "?image=icon-64");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-1/4");
    expect(mocks.input).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("returns the unread original after the transformation consumes its copy and fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.output.mockImplementation(async () => {
      await new Response(mocks.input.mock.calls[0][0]).arrayBuffer();
      throw new Error("Images unavailable");
    });
    const response = await request(undefined, "?image=icon-64");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect((mocks.put.mock.calls[0][0] as Request).url).not.toContain("variant");
  });

  it.each([0, 10 * 1024 * 1024 + 1])("rejects empty or oversized transformation output (%s bytes)", async (length) => {
    mocks.output.mockResolvedValue({ response: () => new Response(new Uint8Array(length)) });
    const response = await request(undefined, "?image=screenshot-640");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("ETag")).toBe(contentEntityTag(file()));
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("serves the original when the Images binding is absent", async () => {
    mocks.getCloudflareContext.mockReturnValue({ env: {}, ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) } });
    const response = await request(undefined, "?image=icon-64");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(mocks.input).not.toHaveBeenCalled();
  });

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
