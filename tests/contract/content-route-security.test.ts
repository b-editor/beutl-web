import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      BEUTL_R2_BUCKET: bucketMocks,
    },
  }),
}));

import { GET } from "../../apps/web/src/app/api/contents/[fileId]/route";

describe("content route access failures", () => {
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
    expect(bucketMocks.get).not.toHaveBeenCalled();
  });
});
