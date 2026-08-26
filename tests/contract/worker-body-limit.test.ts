import { describe, expect, it } from "vitest";
import { fetchWithBodyLimit } from "../../apps/web/src/lib/worker-body-limit";

function chunked(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
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
    expect(response.status).toBe(413);
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
    expect(response.status).toBe(413);
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
    expect(response.status).toBe(413);
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
