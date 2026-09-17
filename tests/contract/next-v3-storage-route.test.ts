import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import * as route from "../../apps/web/src/app/api/v3/[[...route]]/route";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const handlers = route as Record<string, (request: Request) => Promise<Response>>;
const secret = "next-storage-route-test-secret";

describe("Next v3 storage method exports", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    vi.stubEnv("JWT_SECRET", secret);
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function request(method: string, path: string, body?: unknown) {
    expect(handlers[method]).toBeTypeOf("function");
    const token = await sign(
      {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      secret,
      "HS256",
    );
    const binary = body instanceof Uint8Array;
    return handlers[method](
      new Request(`https://example.test/api/v3/storage${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": binary ? "application/octet-stream" : "application/json",
          ...(binary ? { "content-length": String(body.byteLength) } : {}),
        },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      }),
    );
  }

  it.each(["PUT", "PATCH"])(
    "exports %s and runs authentication before storage access",
    async (method) => {
      expect(handlers[method]).toBeTypeOf("function");
      const response = await handlers[method](
        new Request(
          `https://example.test/api/v3/storage/${method === "PUT" ? "uploads/id/parts/1" : "files/id"}`,
          { method, body: "{}" },
        ),
      );
      expect(response.status).toBe(401);
    },
  );

  it("patches a folder through the Next adapter", async () => {
    const created = await request("POST", "/folders", { name: "Before", parentId: null });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await request("PATCH", `/folders/${id}`, { name: "After" })).status).toBe(204);
    expect(memory.state.storageFolders.get(id)?.name).toBe("After");
  });

  it("streams a multipart upload part through the Next adapter", async () => {
    const uploadPart = vi.fn(async (partNumber: number, body: ReadableStream<Uint8Array>) => {
      expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      return { partNumber, etag: "etag" };
    });
    setR2BucketProvider(
      () =>
        ({
          createMultipartUpload: async () => ({ uploadId: "remote" }),
          resumeMultipartUpload: () => ({ uploadPart }),
          head: async () => null,
        }) as never,
    );
    const id = crypto.randomUUID();
    expect(
      (
        await request("POST", "/uploads", {
          id,
          name: "file.bin",
          size: 3,
          mimeType: "application/octet-stream",
        })
      ).status,
    ).toBe(201);
    const response = await request("PUT", `/uploads/${id}/parts/1`, new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partNumber: 1, etag: "etag" });
    expect(uploadPart).toHaveBeenCalledTimes(1);
  });
});
