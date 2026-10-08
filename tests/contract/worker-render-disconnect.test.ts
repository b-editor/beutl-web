import { describe, expect, it } from "vitest";
import { keepRenderingAfterDisconnect } from "../../apps/web/src/lib/worker-render-disconnect";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { state.cancelled = true; },
  });
  return {
    stream,
    state,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
}

async function respond(
  type: string,
  body: ReadableStream<Uint8Array> | string,
  init: RequestInit = {},
) {
  const visitor = new AbortController();
  const ctx = context();
  let forwarded!: Request;
  const response = await keepRenderingAfterDisconnect(
    new Request("https://beutl.beditor.net/ja/store/Beutl.Extensions.Voice", { ...init, signal: visitor.signal }),
    ctx,
    async (request) => {
      forwarded = request;
      return new Response(body, { status: 200, headers: { "content-type": type, "x-render": "1" } });
    },
  );
  return { visitor, ctx, forwarded, response };
}

describe("page renders after a client disconnect", () => {
  it.each(["text/html; charset=utf-8", "text/x-component"])(
    "finishes a %s render that the visitor left, without cancelling it",
    async (type) => {
      const body = controllableBody();
      const { visitor, ctx, forwarded, response } = await respond(type, body.stream);
      body.push("<shell>");
      const reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toBe("<shell>");

      visitor.abort();
      await reader.cancel();
      expect(forwarded.signal.aborted).toBe(false);

      // Next keeps writing until the render is done; the rest is still read.
      body.push("<late-suspense-boundary>");
      body.close();
      await Promise.all(ctx.pending);
      expect(body.state.cancelled).toBe(false);
      expect(forwarded.signal.aborted).toBe(false);
    },
  );

  it("streams a render unchanged while the visitor stays", async () => {
    const { response, ctx } = await respond("text/html; charset=utf-8", "<html>page</html>");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-render")).toBe("1");
    expect(await response.text()).toBe("<html>page</html>");
    await Promise.all(ctx.pending);
  });

  it("still stops file contents when the visitor leaves", async () => {
    const body = controllableBody();
    const { visitor, forwarded, response } = await respond("application/octet-stream", body.stream);
    expect(forwarded.signal.aborted).toBe(false);
    visitor.abort();
    expect(forwarded.signal.aborted).toBe(true);
    await response.body!.cancel();
    expect(body.state.cancelled).toBe(true);
  });

  it("stops other responses at once when the visitor left before they began", async () => {
    const visitor = new AbortController();
    visitor.abort();
    let forwarded!: Request;
    await keepRenderingAfterDisconnect(
      new Request("https://beutl.beditor.net/api/contents/file", { signal: visitor.signal }),
      context(),
      async (request) => {
        forwarded = request;
        expect(request.signal.aborted).toBe(false);
        return new Response("bytes", { headers: { "content-type": "image/png" } });
      },
    );
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("keeps the visitor's signal on POST for AI submissions", async () => {
    const request = new Request("https://beutl.beditor.net/api/internal/ai/videos", { method: "POST", body: "{}" });
    let forwarded!: Request;
    await keepRenderingAfterDisconnect(request, context(), async (next) => {
      forwarded = next;
      return new Response("ok", { headers: { "content-type": "text/html" } });
    });
    expect(forwarded).toBe(request);
  });
});
