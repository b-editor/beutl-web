import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { sign } from "hono/jwt";
import { apiRequestBodyLimit, MAX_API_JSON_REQUEST_BYTES, MAX_GIT_REPOSITORY_THUMBNAIL_BYTES } from "@beutl/core";
import { runWithDbProvider, type PrismaClient } from "@beutl/db";
import { api } from "@beutl/api/app";
import {
  gitRepositoryThumbnailKey,
  gitRepositoryThumbnailPrefix,
  readGitRepositoryThumbnail,
  saveGitRepositoryThumbnail,
  validateGitRepositoryThumbnail,
  type GitRepositoryThumbnailBucket,
} from "@beutl/api/git/thumbnails";
import type { GitEnvironment } from "@beutl/api/git/environment";

const routeMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hostedGit: vi.fn(),
  readGitRepositoryThumbnail: vi.fn(),
}));

vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession: routeMocks.getSession } } }));
vi.mock("@/lib/git-repositories", () => ({
  GitRepositoryError: class GitRepositoryError extends Error {},
  hostedGit: routeMocks.hostedGit,
}));
vi.mock("@beutl/api/git/thumbnails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/api/git/thumbnails")>();
  return {
    ...actual,
    readGitRepositoryThumbnail: (...args: Parameters<typeof actual.readGitRepositoryThumbnail>) =>
      routeMocks.readGitRepositoryThumbnail.getMockImplementation()
        ? routeMocks.readGitRepositoryThumbnail(...args)
        : actual.readGitRepositoryThumbnail(...args),
  };
});

type ThumbnailRoute = typeof import("../../apps/web/src/app/api/repositories/[repositoryId]/thumbnail/route");
let GET: ThumbnailRoute["GET"];
let HEAD: ThumbnailRoute["HEAD"];

beforeAll(async () => {
  ({ GET, HEAD } = await import("../../apps/web/src/app/api/repositories/[repositoryId]/thumbnail/route"));
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makePng(width: number, height: number): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  const idat = new Uint8Array(deflateSync(raw));
  const chunks = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array())];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}

const repoId = "12345678-1234-4123-8123-123456789abc";
const origin = "https://beutl.test";
const createdAt = new Date("2026-10-04T00:00:00Z");
const validPng = makePng(4, 3);
const env: GitEnvironment = {
  BEUTL_GIT_ENABLED: "true",
  BEUTL_S3_ENDPOINT: "https://s3.example.test",
  BEUTL_S3_REGION: "test",
  BEUTL_S3_BUCKET: "git",
  BEUTL_S3_ACCESS_KEY_ID: "test",
  BEUTL_S3_SECRET_ACCESS_KEY: "test",
};

function memoryBucket() {
  const stored = new Map<string, Uint8Array>();
  const pruneGitVersions = vi.fn(async () => undefined);
  const del = vi.fn(async (key: string | string[]) => {
    for (const k of Array.isArray(key) ? key : [key]) stored.delete(k);
  });
  const put = vi.fn(async (key: string, value: Uint8Array) => {
    stored.set(key, value.slice());
    return { versionId: "v2" };
  });
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    if (!value) return null;
    return {
      size: value.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      }),
      arrayBuffer: async () => value.slice().buffer,
    };
  });
  const head = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { size: value.byteLength } : null;
  });
  return {
    stored,
    bucket: { get, head, put, delete: del, pruneGitVersions } satisfies GitRepositoryThumbnailBucket,
    mocks: { get, head, put, delete: del, pruneGitVersions },
  };
}

describe("repository thumbnail body limits and validation", () => {
  it("allows up to 1 MiB only on PUT /api/v3/repos/:id/thumbnail", () => {
    expect(apiRequestBodyLimit("PUT", `/api/v3/repos/${repoId}/thumbnail`, "image/png"))
      .toBe(MAX_GIT_REPOSITORY_THUMBNAIL_BYTES);
    expect(apiRequestBodyLimit("POST", `/api/v3/repos/${repoId}/thumbnail`, "image/png"))
      .toBe(MAX_API_JSON_REQUEST_BYTES);
    expect(apiRequestBodyLimit("PUT", `/api/v3/repos/${repoId}`, "image/png"))
      .toBe(MAX_API_JSON_REQUEST_BYTES);
  });

  it("accepts a valid PNG within thumbnail dimensions and rejects invalid or oversized images", async () => {
    expect(await validateGitRepositoryThumbnail(validPng)).toBe(true);
    expect(await validateGitRepositoryThumbnail(new Uint8Array())).toBe(false);
    expect(await validateGitRepositoryThumbnail(new TextEncoder().encode("not a png"))).toBe(false);
    const corrupted = validPng.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(await validateGitRepositoryThumbnail(corrupted)).toBe(false);
    expect(await validateGitRepositoryThumbnail(makePng(1025, 16))).toBe(false);
  });
});

describe("repository thumbnail storage and metadata", () => {
  beforeEach(() => {
    routeMocks.readGitRepositoryThumbnail.mockReset();
  });

  it("saves a validated PNG, updates thumbnailUpdatedAt, and prunes older object versions", async () => {
    const { stored, bucket, mocks } = memoryBucket();
    const row = { id: repoId, ownerId: "owner", name: "Demo", createdAt, updatedAt: createdAt, thumbnailUpdatedAt: null as Date | null };
    const db = {
      gitRepository: {
        findFirst: vi.fn(async ({ where }) => where.id === repoId && where.ownerId === "owner" ? row : null),
        update: vi.fn(async ({ data }) => {
          row.thumbnailUpdatedAt = data.thumbnailUpdatedAt;
          return { ...row };
        }),
      },
    } as unknown as PrismaClient;

    const result = await runWithDbProvider(async () => db, () =>
      saveGitRepositoryThumbnail(env, "owner", repoId, validPng, origin, { bucket }));

    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.repository.thumbnailUpdatedAt).toBe(row.thumbnailUpdatedAt!.toISOString());
    }
    const key = gitRepositoryThumbnailKey(repoId);
    expect(key.startsWith(gitRepositoryThumbnailPrefix(repoId))).toBe(true);
    expect(stored.get(key)).toEqual(validPng);
    expect(mocks.pruneGitVersions).toHaveBeenCalledWith(gitRepositoryThumbnailPrefix(repoId));

    const loaded = await runWithDbProvider(async () => db, () =>
      readGitRepositoryThumbnail(env, "owner", repoId, { bucket }));
    expect(loaded?.size).toBe(validPng.byteLength);
    expect(new Uint8Array(await new Response(loaded!.body).arrayBuffer())).toEqual(validPng);

    const head = await runWithDbProvider(async () => db, () =>
      readGitRepositoryThumbnail(env, "owner", repoId, { headOnly: true, bucket }));
    expect(head?.size).toBe(validPng.byteLength);
    expect(head?.body).toBeUndefined();
  });

  it("refuses another account without touching storage and removes orphaned bytes on deletion race", async () => {
    const { stored, bucket, mocks } = memoryBucket();
    const db = {
      gitRepository: {
        findFirst: vi.fn(async ({ where }) => where.ownerId === "owner" ? { id: repoId } : null),
        update: vi.fn(async () => { throw { code: "P2025" }; }),
      },
    } as unknown as PrismaClient;

    const unauthorized = await runWithDbProvider(async () => db, () =>
      saveGitRepositoryThumbnail(env, "other", repoId, validPng, origin, { bucket }));
    expect(unauthorized).toEqual({ status: "notFound" });
    expect(mocks.put).not.toHaveBeenCalled();

    const raced = await runWithDbProvider(async () => db, () =>
      saveGitRepositoryThumbnail(env, "owner", repoId, validPng, origin, { bucket }));
    expect(raced).toEqual({ status: "notFound" });
    expect(mocks.delete).toHaveBeenCalledWith(gitRepositoryThumbnailKey(repoId));
    expect(stored.size).toBe(0);
  });

  it("returns null without querying storage when thumbnailUpdatedAt is null", async () => {
    const { bucket, mocks } = memoryBucket();
    const db = {
      gitRepository: {
        findFirst: vi.fn(async () => ({ thumbnailUpdatedAt: null })),
      },
    } as unknown as PrismaClient;

    const result = await runWithDbProvider(async () => db, () =>
      readGitRepositoryThumbnail(env, "owner", repoId, { bucket }));
    expect(result).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
  });
});

describe("dashboard repository thumbnail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.getSession.mockResolvedValue({ user: { id: "owner" } });
    routeMocks.hostedGit.mockResolvedValue({ env, origin });
  });
  afterEach(() => {
    routeMocks.readGitRepositoryThumbnail.mockReset();
  });

  it.each([
    ["an invalid id", "not-a-repo", () => undefined],
    ["a signed-out caller", repoId, () => routeMocks.getSession.mockResolvedValue(null)],
    ["a missing thumbnail or unowned repo", repoId, () => routeMocks.readGitRepositoryThumbnail.mockResolvedValue(null)],
  ])("returns a private 404 for %s", async (_label, id, arrange) => {
    arrange();
    const response = await GET(
      new Request(`http://localhost/api/repositories/${id}/thumbnail`) as Parameters<ThumbnailRoute["GET"]>[0],
      { params: Promise.resolve({ repositoryId: id }) },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("streams PNG bytes for GET and headers only for HEAD", async () => {
    routeMocks.readGitRepositoryThumbnail.mockImplementation(async (_e, _u, _id, options) => ({
      size: validPng.byteLength,
      updatedAt: createdAt,
      ...(options?.headOnly ? {} : { body: new Response(validPng).body! }),
    }));

    const getRes = await GET(
      new Request(`http://localhost/api/repositories/${repoId}/thumbnail`) as Parameters<ThumbnailRoute["GET"]>[0],
      { params: Promise.resolve({ repositoryId: repoId }) },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toBe("image/png");
    expect(getRes.headers.get("Content-Length")).toBe(String(validPng.byteLength));
    expect(getRes.headers.get("Cache-Control")).toBe("no-store");
    expect(getRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(validPng);

    const headRes = await HEAD(
      new Request(`http://localhost/api/repositories/${repoId}/thumbnail`, { method: "HEAD" }) as Parameters<ThumbnailRoute["HEAD"]>[0],
      { params: Promise.resolve({ repositoryId: repoId }) },
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Length")).toBe(String(validPng.byteLength));
    expect(headRes.body).toBeNull();
  });
});

describe("v3 repository thumbnail upload without Content-Length", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts a streamed PNG upload when no Content-Length header is present", async () => {
    vi.stubEnv("JWT_SECRET", "thumbnail-route-secret");
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
    const token = await sign(
      {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      "thumbnail-route-secret",
      "HS256",
    );
    const row = {
      id: repoId,
      ownerId: "owner",
      name: "Demo",
      createdAt,
      updatedAt: createdAt,
      thumbnailUpdatedAt: null as Date | null,
    };
    const db = {
      gitRepository: {
        findFirst: vi.fn(async () => ({ id: repoId })),
        update: vi.fn(async ({ data }) => ({ ...row, thumbnailUpdatedAt: data.thumbnailUpdatedAt })),
      },
    } as unknown as PrismaClient;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("versions=")) {
        return new Response("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>", { status: 200 });
      }
      return new Response(null, { status: 200, headers: { "x-amz-version-id": "v1" } });
    }));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(validPng);
        controller.close();
      },
    });
    const request = new Request(`${origin}/api/v3/repos/${repoId}/thumbnail`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await runWithDbProvider(async () => db, () =>
      api.fetch(request, {
        ...env,
        BEUTL_GIT_REPOSITORIES: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
      }));
    expect(response.status).toBe(200);
    const body = await response.json() as { thumbnailUpdatedAt: string | null };
    expect(body.thumbnailUpdatedAt).not.toBeNull();
  });
});
