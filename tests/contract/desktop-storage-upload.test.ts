import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { api, setR2BucketProvider } from "@beutl/api";
import { setDbProvider } from "@beutl/db";
import {
  apiRequestBodyLimit,
  STORAGE_UPLOAD_PART_BYTES,
  STORAGE_UPLOAD_FINISH_BODY_BYTES,
} from "@beutl/core";
import { withBoundedBody } from "../../packages/api/src/worker";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe.each([false, true])(
  "desktop storage multipart uploads (known-length stream: %s)",
  (fixedLength) => {
    let memory: ReturnType<typeof createInMemoryPrisma>;
    let parts: Map<number, number>;
    const abort = vi.fn(async () => {});
    beforeEach(() => {
      if (fixedLength) {
        vi.stubGlobal(
          "FixedLengthStream",
          class extends TransformStream<Uint8Array, Uint8Array> {
            constructor(size: number) {
              let received = 0;
              super({
                transform(chunk, controller) {
                  received += chunk.byteLength;
                  if (received > size) throw new Error("Too long");
                  controller.enqueue(chunk);
                },
                flush() {
                  if (received !== size) throw new Error("Too short");
                },
              });
            }
          },
        );
      }
      memory = createInMemoryPrisma();
      setDbProvider(async () => memory.prisma as never);
      parts = new Map();
      abort.mockClear();
      setR2BucketProvider(
        () =>
          ({
            head: async () => null,
            delete: async () => {},
            createMultipartUpload: async () => ({ uploadId: "remote" }),
            resumeMultipartUpload: () => ({
              uploadPart: async (partNumber: number, stream: ReadableStream<Uint8Array>) => {
                parts.set(partNumber, (await new Response(stream).arrayBuffer()).byteLength);
                return { partNumber, etag: `etag-${partNumber}` };
              },
              complete: async () => ({ size: [...parts.values()].reduce((a, b) => a + b, 0) }),
              abort,
            }),
          }) as never,
      );
      vi.stubEnv("JWT_SECRET", "storage-drag-test-secret");
      vi.stubEnv("JWT_ISSUER", "");
      vi.stubEnv("JWT_AUDIENCE", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    async function request(path: string, method: string, body?: unknown, user = "owner") {
      const token = await sign(
        {
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": user,
          exp: Math.floor(Date.now() / 1000) + 300,
        },
        "storage-drag-test-secret",
        "HS256",
      );
      const binary = body instanceof Uint8Array;
      const raw = new Request(`https://example.test/api/v3/storage/uploads${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": binary ? "application/octet-stream" : "application/json",
          ...(binary ? { "content-length": String(body.byteLength) } : {}),
        },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      });
      return api.fetch(withBoundedBody(raw, () => {})!);
    }

    it("starts, streams and completes an authenticated upload with idempotent receipts", async () => {
      const id = crypto.randomUUID();
      const input = { id, name: "clip.bin", mimeType: "application/octet-stream", size: 3 };
      expect((await request("", "POST", input)).status).toBe(201);
      expect((await request(`/${id}/parts/1`, "PUT", new Uint8Array([1, 2, 3]))).status).toBe(200);
      const completed = await request(`/${id}/complete`, "POST", {
        parts: [{ partNumber: 1, etag: "etag-1" }],
      });
      expect(completed.status).toBe(200);
      const result = await completed.json();
      expect(memory.state.files.get(result.id)?.size).toBe(3);
      expect(memory.state.files.get(result.id)?.visibility).toBe("PRIVATE");
      const replay = await request(`/${id}/complete`, "POST", {
        parts: [{ partNumber: 1, etag: "etag-1" }],
      });
      expect((await replay.json()).id).toBe(result.id);
      expect(memory.state.files.size).toBe(1);
    });

    it("isolates uploads by owner and cancels unfinished parts", async () => {
      const id = crypto.randomUUID();
      await request("", "POST", {
        id,
        name: "clip.bin",
        mimeType: "application/octet-stream",
        size: 3,
      });
      expect((await request(`/${id}/parts/1`, "PUT", new Uint8Array([1]), "other")).status).toBe(
        404,
      );
      expect((await request(`/${id}`, "DELETE", undefined, "other")).status).toBe(404);
      expect(abort).not.toHaveBeenCalled();
      expect((await request(`/${id}`, "DELETE")).status).toBe(204);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(memory.state.files.size).toBe(0);
    });

    it("bounds API parts and completion payloads at the Worker boundary", () => {
      expect(
        apiRequestBodyLimit(
          "PUT",
          "/api/v3/storage/uploads/id/parts/1",
          "application/octet-stream",
        ),
      ).toBe(STORAGE_UPLOAD_PART_BYTES);
      expect(
        apiRequestBodyLimit("POST", "/api/v3/storage/uploads/id/complete", "application/json"),
      ).toBe(STORAGE_UPLOAD_FINISH_BODY_BYTES);
      const request = new Request("https://example.test/api/v3/storage/uploads/id/parts/1", {
        method: "PUT",
        headers: { "content-length": String(STORAGE_UPLOAD_PART_BYTES + 1) },
        body: "x",
      });
      expect(withBoundedBody(request, () => {})).toBeNull();
    });

    it("rejects unauthenticated and malformed start requests", async () => {
      expect(
        (await api.request("/api/v3/storage/uploads", { method: "POST", body: "{}" })).status,
      ).toBe(401);
      expect(
        (
          await request("", "POST", {
            id: crypto.randomUUID(),
            name: "../file",
            mimeType: "x",
            size: 1,
          })
        ).status,
      ).toBe(400);
      expect(memory.state.storageUploads.size).toBe(0);
    });
  },
);
