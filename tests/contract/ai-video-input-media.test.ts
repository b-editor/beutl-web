import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import {
  AI_VIDEO_INPUT_PREFIX,
  isVideoInputMediaId,
  publishVideoInputMedia,
  videoInputObjectKey,
} from "../../packages/api/src/ai/video-input-media";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PICTURE = new Uint8Array([1, 2, 3, 4]).buffer;

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

describe("serving the pictures a video request works from", () => {
  let objects: Map<string, { bytes: ArrayBuffer; contentType?: string }>;
  let put: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    objects = new Map();
    put = vi.fn(async (key: string, value: ArrayBuffer, options?: {
      httpMetadata?: { contentType?: string };
    }) => {
      objects.set(key, {
        bytes: value,
        ...(options?.httpMetadata?.contentType
          ? { contentType: options.httpMetadata.contentType }
          : {}),
      });
    });
    get = vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? { arrayBuffer: async () => object.bytes, size: object.bytes.byteLength }
        : null;
    });
    setR2BucketProvider(() => ({ put, get, delete: vi.fn() }));
  });

  it("stores under a prefix the route is confined to, and schedules its removal", async () => {
    const { url, objectKey } = await publishVideoInputMedia({
      jobId: JOB_ID,
      bytes: PICTURE,
      mimeType: "image/png",
      origin: "https://beutl.beditor.net",
    });

    expect(objectKey.startsWith(`${AI_VIDEO_INPUT_PREFIX}/${JOB_ID}/`)).toBe(
      true,
    );
    expect(new URL(url).origin).toBe("https://beutl.beditor.net");
    expect(new URL(url).pathname).toBe(
      `/api/v3/ai/videos/media/${JOB_ID}/${objectKey.split("/").pop()}`,
    );
    // Registered as it is written, not when the job ends: a job that never
    // finishes must not leave the picture behind.
    expect(put).toHaveBeenCalledOnce();
  });

  it("hands the bytes to an unauthenticated caller, because a provider is one", async () => {
    const { url } = await publishVideoInputMedia({
      jobId: JOB_ID,
      bytes: PICTURE,
      mimeType: "image/png",
      origin: "https://beutl.beditor.net",
    });

    const response = await makeApp().request(new URL(url).pathname);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    // The stored type is not echoed back: a provider needs bytes, and handing
    // back a type a caller chose invites it being interpreted as markup.
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("reads nothing outside its own prefix", async () => {
    // The URL is the whole of the capability, so the route must not be usable
    // to name another object in the bucket.
    objects.set("ai/image/secret/result.png", { bytes: PICTURE });

    const response = await makeApp().request(
      "/api/v3/ai/videos/media/..%2F..%2Fimage/secret",
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a pair of UUIDs", async () => {
    for (const path of [
      `/api/v3/ai/videos/media/${JOB_ID}/not-a-uuid`,
      "/api/v3/ai/videos/media/not-a-uuid/" + JOB_ID,
    ]) {
      expect((await makeApp().request(path)).status).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("answers 404 for a picture that has already been removed", async () => {
    const response = await makeApp().request(
      `/api/v3/ai/videos/media/${JOB_ID}/33333333-3333-4333-8333-333333333333`,
    );

    expect(response.status).toBe(404);
  });

  it("names an object only from the two ids", () => {
    expect(videoInputObjectKey(JOB_ID, "abc")).toBe(
      `${AI_VIDEO_INPUT_PREFIX}/${JOB_ID}/abc`,
    );
    expect(isVideoInputMediaId(JOB_ID)).toBe(true);
    expect(isVideoInputMediaId("../../etc")).toBe(false);
    expect(isVideoInputMediaId("")).toBe(false);
  });
});
