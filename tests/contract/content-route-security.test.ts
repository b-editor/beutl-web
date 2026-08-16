import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findFileForContentAccess: vi.fn(),
  existsUserPaymentHistory: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  tryGetUserIdFromHeaders: vi.fn(),
}));
const bucketMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@beutl/db", () => dbMocks);
vi.mock("@beutl/api", () => ({
  tryGetUserIdFromHeaders: authMocks.tryGetUserIdFromHeaders,
}));
vi.mock("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession,
    },
  },
}));
type ContentGet =
  typeof import("../../apps/web/src/app/api/contents/[fileId]/route").GET;

let GET: ContentGet;

beforeAll(async () => {
  const requireFromWeb = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  vi.doMock(requireFromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: () => ({
      env: {
        BEUTL_R2_BUCKET: bucketMocks,
      },
    }),
  }));
  ({ GET } = await import(
    "../../apps/web/src/app/api/contents/[fileId]/route"
  ));
});

const CONTENT_BYTES = new Uint8Array([1, 2, 3, 4]);

function publicFile(mimeType: string) {
  return {
    name: "result file.webm",
    objectKey: "public/file-1",
    visibility: "PUBLIC" as const,
    userId: "owner",
    mimeType,
    Package: [],
    Profile: [],
    PackageScreenshot: [],
    Release: [],
  };
}

async function requestContent() {
  return await GET(
    new Request("http://localhost/api/contents/file-1") as Parameters<
      typeof GET
    >[0],
    { params: Promise.resolve({ fileId: "file-1" }) },
  );
}

describe("content route security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    authMocks.tryGetUserIdFromHeaders.mockResolvedValue(null);
    dbMocks.existsUserPaymentHistory.mockResolvedValue(false);
  });

  it("hides denied file existence behind a no-store 404", async () => {
    dbMocks.findFileForContentAccess.mockResolvedValue({
      objectKey: "private/file-1",
      visibility: "PRIVATE",
      userId: "owner",
      mimeType: "application/octet-stream",
      Package: [],
      Profile: [],
      PackageScreenshot: [],
      Release: [],
    });

    const response = await GET(
      new Request("http://localhost/api/contents/file-1") as Parameters<typeof GET>[0],
      { params: Promise.resolve({ fileId: "file-1" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "ファイルが見つかりません",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(bucketMocks.get).not.toHaveBeenCalled();
  });

  it.each([
    "text/html; charset=utf-8",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
  ])("forces active content type %s to download as inert bytes", async (mimeType) => {
    dbMocks.findFileForContentAccess.mockResolvedValue(publicFile(mimeType));
    bucketMocks.get.mockResolvedValue({
      body: CONTENT_BYTES,
      size: CONTENT_BYTES.byteLength,
    });

    const response = await requestContent();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"result file.webm\"; filename*=UTF-8''result%20file.webm",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT_BYTES);
  });

  it.each(["image/png", "video/mp4"])(
    "keeps legitimate %s content inline with hardened headers",
    async (mimeType) => {
      dbMocks.findFileForContentAccess.mockResolvedValue(publicFile(mimeType));
      bucketMocks.get.mockResolvedValue({
        body: CONTENT_BYTES,
        size: CONTENT_BYTES.byteLength,
      });

      const response = await requestContent();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(mimeType);
      expect(response.headers.get("Content-Disposition")).toBe(
        "inline; filename=\"result file.webm\"; filename*=UTF-8''result%20file.webm",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(response.headers.get("Cache-Control")).toBe(
        "public, no-cache, must-revalidate",
      );
      expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        CONTENT_BYTES,
      );
    },
  );

  it("preserves package bytes while forcing a safe download", async () => {
    dbMocks.findFileForContentAccess.mockResolvedValue(
      publicFile("application/zip"),
    );
    bucketMocks.get.mockResolvedValue({
      body: CONTENT_BYTES,
      size: CONTENT_BYTES.byteLength,
    });

    const response = await requestContent();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"result file.webm\"; filename*=UTF-8''result%20file.webm",
    );
    expect(response.headers.get("Content-Length")).toBe(
      CONTENT_BYTES.byteLength.toString(),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT_BYTES);
  });
});
