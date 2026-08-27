import { describe, expect, it } from "vitest";
import { fetchWithBodyLimit } from "../../apps/web/src/lib/worker-body-limit";
import {
  MAX_AUTH_REQUEST_BODY_BYTES,
  MAX_INTERNAL_STORAGE_START_BODY_BYTES,
  MAX_STRIPE_WEBHOOK_BODY_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";

function chunked(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

async function expectFileTooLarge(response: Response): Promise<void> {
  expect(response.status).toBe(413);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual({
    error_code: "fileIsTooLarge",
    message: expect.any(String),
    documentation_url: null,
  });
}

describe("OpenNext outer body limit", () => {
  it("maps a generated handler buffer rejection to 413", async () => {
    const response = await fetchWithBodyLimit(
      new Request("https://beutl.beditor.net/ja/dashboard", {
        method: "POST",
        body: chunked(150 * 1024 * 1024),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {},
      {},
      async (request) => {
        await request.arrayBuffer();
        return new Response("unexpected", { status: 200 });
      },
    );
    await expectFileTooLarge(response);
  });

  it("passes a valid chunked request downstream", async () => {
    let seen = 0;
    const response = await fetchWithBodyLimit(
      new Request("https://beutl.beditor.net/ja/dashboard", {
        method: "POST",
        body: chunked(1024),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {},
      {},
      async (request) => {
        seen = (await request.arrayBuffer()).byteLength;
        return new Response("ok", { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(seen).toBe(1024);
  });

  it("rejects a declared oversized body before downstream", async () => {
    let called = false;
    const response = await fetchWithBodyLimit(
      new Request("https://beutl.beditor.net/ja/dashboard", {
        method: "POST",
        headers: { "content-length": String(150 * 1024 * 1024) },
        body: "x",
      }),
      {},
      {},
      async () => {
        called = true;
        return new Response("unexpected", { status: 200 });
      },
    );
    await expectFileTooLarge(response);
    expect(called).toBe(false);
  });

  it("ignores a forged low Content-Length while downstream consumes the body", async () => {
    const response = await fetchWithBodyLimit(
      new Request("https://beutl.beditor.net/api/v3/unknown", {
        method: "POST",
        headers: { "content-length": "1" },
        body: chunked(150 * 1024 * 1024),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {},
      {},
      async (request) => {
        await request.arrayBuffer();
        return new Response("unexpected", { status: 200 });
      },
    );
    await expectFileTooLarge(response);
  });

  it.each([
    ["auth", "POST", "/api/auth/sign-in/email", MAX_AUTH_REQUEST_BODY_BYTES],
    ["Stripe webhook", "POST", "/api/stripe/webhook", MAX_STRIPE_WEBHOOK_BODY_BYTES],
    ["storage control", "POST", "/api/internal/storage/uploads", MAX_INTERNAL_STORAGE_START_BODY_BYTES],
  ])("rejects declared oversized %s bodies before OpenNext", async (
    _name,
    method,
    pathname,
    limit,
  ) => {
    let called = false;
    const response = await fetchWithBodyLimit(
      new Request(`https://beutl.beditor.net${pathname}`, {
        method,
        headers: {
          "content-type": "application/json",
          "content-length": String(limit + 1),
        },
        body: "x",
      }),
      {},
      {},
      async () => {
        called = true;
        return new Response("unexpected");
      },
    );
    await expectFileTooLarge(response);
    expect(called).toBe(false);
  });

  it("passes a valid storage part and lets OpenNext restore its actual length", async () => {
    const actualLength = 1024;
    const response = await fetchWithBodyLimit(
      new Request(
        "https://beutl.beditor.net/api/internal/storage/uploads/upload-1/parts/1",
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(actualLength),
          },
          body: chunked(actualLength),
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      ),
      {},
      {},
      async (request) => {
        expect(request.headers.get("content-length")).toBeNull();
        const body = await request.arrayBuffer();
        const openNextHeaders = new Headers(request.headers);
        openNextHeaders.set("content-length", String(body.byteLength));
        expect(Number(openNextHeaders.get("content-length")))
          .toBe(actualLength);
        expect(body.byteLength).toBeLessThanOrEqual(STORAGE_UPLOAD_PART_BYTES);
        return new Response("ok");
      },
    );
    expect(response.status).toBe(200);
  });

  it("does not drain an unconsumed body just to change an early response", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(150 * 1024 * 1024));
        controller.close();
      },
    });
    const response = await fetchWithBodyLimit(
      new Request("https://beutl.beditor.net/api/v3/unknown", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {},
      {},
      async () => new Response(null, { status: 401 }),
    );
    expect(response.status).toBe(401);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("propagates an unrelated downstream failure", async () => {
    const failure = new Error("downstream failed");
    await expect(
      fetchWithBodyLimit(
        new Request("https://beutl.beditor.net/ja/dashboard", {
          method: "POST",
          body: chunked(1024),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
        {},
        {},
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });
});
