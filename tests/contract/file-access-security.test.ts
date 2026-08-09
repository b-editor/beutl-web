import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";

const dbMocks = vi.hoisted(() => ({
  findFileForApi: vi.fn(),
  existsUserPaymentHistory: vi.fn(),
}));

vi.mock("@beutl/db", () => dbMocks);

import files from "../../packages/api/src/v3/files";

const JWT_SECRET = "file-access-test-secret";
const OWNER_ID = "file-owner";
const OTHER_USER_ID = "other-user";

type FileRecord = {
  id: string;
  name: string;
  mimeType: string;
  userId: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  size: bigint;
  sha256: string;
  Package: Array<{ userId: string; published: boolean }>;
  Profile: Array<{ userId: string }>;
  PackageScreenshot: Array<{
    package: { userId: string; published: boolean };
  }>;
  Release: Array<{
    published: boolean;
    package: {
      id: string;
      userId: string;
      published: boolean;
      packagePricing: Array<{ id: string; price: number }>;
    };
  }>;
};

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file-1",
    name: "asset.beutl",
    mimeType: "application/octet-stream",
    userId: OWNER_ID,
    visibility: "PRIVATE",
    size: 42n,
    sha256: "abc123",
    Package: [],
    Profile: [],
    PackageScreenshot: [],
    Release: [],
    ...overrides,
  };
}

function makeApp() {
  return new Hono().route("/api/v3/files", files);
}

async function authorization(userId: string) {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        userId,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return { Authorization: `Bearer ${token}` };
}

async function requestFile(userId?: string) {
  return await makeApp().request("/api/v3/files/file-1", {
    headers: userId ? await authorization(userId) : undefined,
  });
}

describe("v3 file metadata access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
    dbMocks.existsUserPaymentHistory.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns private metadata to its owner", async () => {
    dbMocks.findFileForApi.mockResolvedValue(fileRecord());

    const response = await requestFile(OWNER_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
    expect(await response.json()).toEqual({
      id: "file-1",
      name: "asset.beutl",
      contentType: "application/octet-stream",
      downloadUrl: "http://localhost/api/contents/file-1",
      size: 42,
      sha256: "abc123",
    });
  });

  it("does not enumerate private metadata to other callers", async () => {
    dbMocks.findFileForApi.mockResolvedValue(fileRecord());

    const [otherResponse, anonymousResponse] = await Promise.all([
      requestFile(OTHER_USER_ID),
      requestFile(),
    ]);

    expect(otherResponse.status).toBe(404);
    expect(anonymousResponse.status).toBe(404);
    expect(await otherResponse.json()).toMatchObject({
      error_code: "assetNotFound",
    });
    expect(await anonymousResponse.json()).toMatchObject({
      error_code: "assetNotFound",
    });
  });

  it("keeps explicitly public metadata available anonymously", async () => {
    dbMocks.findFileForApi.mockResolvedValue(
      fileRecord({ visibility: "PUBLIC" }),
    );

    expect((await requestFile()).status).toBe(200);
  });

  it("keeps published package and free release metadata available", async () => {
    dbMocks.findFileForApi
      .mockResolvedValueOnce(
        fileRecord({
          visibility: "DEDICATED",
          Package: [{ userId: OWNER_ID, published: true }],
        }),
      )
      .mockResolvedValueOnce(
        fileRecord({
          visibility: "DEDICATED",
          Release: [
            {
              published: true,
              package: {
                id: "package-1",
                userId: OWNER_ID,
                published: true,
                packagePricing: [],
              },
            },
          ],
        }),
      );

    expect((await requestFile()).status).toBe(200);
    expect((await requestFile()).status).toBe(200);
  });

  it("keeps an all-zero-priced release available anonymously", async () => {
    dbMocks.findFileForApi.mockResolvedValue(
      fileRecord({
        visibility: "DEDICATED",
        Release: [
          {
            published: true,
            package: {
              id: "zero-priced-package",
              userId: OWNER_ID,
              published: true,
              packagePricing: [{ id: "zero-price", price: 0 }],
            },
          },
        ],
      }),
    );

    expect((await requestFile()).status).toBe(200);
    expect(dbMocks.existsUserPaymentHistory).not.toHaveBeenCalled();
  });

  it("requires payment for a paid release but allows its owner", async () => {
    dbMocks.findFileForApi.mockResolvedValue(
      fileRecord({
        visibility: "DEDICATED",
        Release: [
          {
            published: true,
            package: {
              id: "paid-package",
              userId: OWNER_ID,
              published: true,
              packagePricing: [{ id: "price-1", price: 100 }],
            },
          },
        ],
      }),
    );

    expect((await requestFile()).status).toBe(403);
    expect((await requestFile(OTHER_USER_ID)).status).toBe(403);
    expect((await requestFile(OWNER_ID)).status).toBe(200);

    dbMocks.existsUserPaymentHistory.mockResolvedValue(true);
    expect((await requestFile(OTHER_USER_ID)).status).toBe(200);
    expect(dbMocks.existsUserPaymentHistory).toHaveBeenCalledWith({
      userId: OTHER_USER_ID,
      packageId: "paid-package",
    });
  });

  it("hides unpublished dedicated metadata from non-owners", async () => {
    dbMocks.findFileForApi.mockResolvedValue(
      fileRecord({
        visibility: "DEDICATED",
        Release: [
          {
            published: false,
            package: {
              id: "draft-package",
              userId: OWNER_ID,
              published: false,
              packagePricing: [],
            },
          },
        ],
      }),
    );

    expect((await requestFile(OTHER_USER_ID)).status).toBe(404);
    expect((await requestFile(OWNER_ID)).status).toBe(200);
  });
});
