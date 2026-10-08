import { describe, expect, it } from "vitest";
import { keepRenderingAfterDisconnect } from "../../apps/web/src/lib/worker-render-disconnect";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ORIGIN = "https://beutl.beditor.net";

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

/** Produces each chunk only when read, and only once `render()` is called. */
function pulledBody(chunks: string[]) {
  const state = { cancelled: false, drained: false };
  let render!: () => void;
  const rendering = new Promise<void>((resolve) => { render = resolve; });
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await rendering;
      if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]));
      else {
        state.drained = true;
        controller.close();
      }
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state, render };
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
}

async function respond(
  type: string,
  body: ReadableStream<Uint8Array> | string,
  path = "/ja/store/Beutl.Extensions.Voice",
) {
  const visitor = new AbortController();
  const ctx = context();
  let forwarded!: Request;
  let heldBeforeResponse = 0;
  const response = await keepRenderingAfterDisconnect(
    new Request(`${ORIGIN}${path}`, { signal: visitor.signal }),
    ctx,
    async (request) => {
      forwarded = request;
      heldBeforeResponse = ctx.pending.length;
      return new Response(body, { status: 200, headers: { "content-type": type, "x-render": "1" } });
    },
  );
  return { visitor, ctx, forwarded, response, heldBeforeResponse };
}

function settled(promises: Promise<unknown>[]) {
  let done = false;
  void Promise.all(promises).then(() => { done = true; });
  return () => done;
}

describe("page renders after a client disconnect", () => {
  it.each(["text/html; charset=utf-8", "text/x-component"])(
    "finishes a %s render that the visitor left, without cancelling it",
    async (type) => {
      const body = controllableBody();
      const { visitor, ctx, forwarded, response, heldBeforeResponse } = await respond(type, body.stream);
      // The invocation is held before the render answers, not only once it has.
      expect(heldBeforeResponse).toBe(1);
      body.push("<shell>");
      const reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toBe("<shell>");

      visitor.abort();
      await reader.cancel();
      expect(forwarded.signal.aborted).toBe(false);
      const isSettled = settled(ctx.pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(isSettled()).toBe(false);

      // Next keeps writing until the render is done; the rest is still read.
      body.push("<late-suspense-boundary>");
      body.close();
      await Promise.all(ctx.pending);
      expect(body.state.cancelled).toBe(false);
      expect(forwarded.signal.aborted).toBe(false);
    },
  );

  it.each([["before", true], ["after", false]])(
    "finishes a render whose body nobody reads or cancels once the visitor left %s it began",
    async (_when, leftFirst) => {
      // A navigation the client router aborted: the runtime may drop the
      // response without reading or cancelling it. Nothing else can make
      // progress then, so a held waitUntil would be reported as a hang.
      const visitor = new AbortController();
      if (leftFirst) visitor.abort();
      const ctx = context();
      const body = pulledBody(["0:", "1:", "2:", "3:"]);
      await keepRenderingAfterDisconnect(
        new Request(`${ORIGIN}/ja/dashboard/account/billing`, { signal: visitor.signal }),
        ctx,
        async () => new Response(body.stream, { headers: { "content-type": "text/x-component" } }),
      );
      if (!leftFirst) visitor.abort();
      body.render();

      const finished = await Promise.race([
        Promise.all(ctx.pending).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      expect(finished).toBe(true);
      // The render was read to its end, not merely released.
      expect(body.state.drained).toBe(true);
      expect(body.state.cancelled).toBe(false);
    },
  );

  it("streams a render unchanged while the visitor stays", async () => {
    const { response, ctx } = await respond("text/html; charset=utf-8", "<html>page</html>");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-render")).toBe("1");
    expect(await response.text()).toBe("<html>page</html>");
    await Promise.all(ctx.pending);
  });

  it("passes the disconnect to a page-path response that is not a render", async () => {
    const body = controllableBody();
    const { visitor, ctx, forwarded, response } = await respond("image/png", body.stream, "/_next/image");
    await Promise.all(ctx.pending);
    expect(forwarded.signal.aborted).toBe(false);
    visitor.abort();
    expect(forwarded.signal.aborted).toBe(true);
    await response.body!.cancel();
    expect(body.state.cancelled).toBe(true);
  });

  it("stops a page-path response at once when the visitor left before it began", async () => {
    const visitor = new AbortController();
    let forwarded!: Request;
    await keepRenderingAfterDisconnect(
      new Request(`${ORIGIN}/ja/account/native-auth/sign-in-with`, { signal: visitor.signal }),
      context(),
      async (request) => {
        forwarded = request;
        visitor.abort();
        return new Response(null, { status: 307, headers: { location: "/ja" } });
      },
    );
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("gives /api/* the visitor's signal before any headers", async () => {
    const visitor = new AbortController();
    const request = new Request(`${ORIGIN}/api/repositories/demo/content?ref=main&path=a.bin`, { signal: visitor.signal });
    const ctx = context();
    let abortedWhileFetching = false;
    await keepRenderingAfterDisconnect(request, ctx, async (forwarded) => {
      expect(forwarded).toBe(request);
      visitor.abort();
      abortedWhileFetching = forwarded.signal.aborted;
      return new Response("bytes", { headers: { "content-type": "application/octet-stream" } });
    });
    expect(abortedWhileFetching).toBe(true);
    expect(ctx.pending).toHaveLength(0);
  });

  it("keeps the visitor's signal on POST for AI submissions", async () => {
    const request = new Request(`${ORIGIN}/ja/dashboard/ai`, { method: "POST", body: "{}" });
    let forwarded!: Request;
    await keepRenderingAfterDisconnect(request, context(), async (next) => {
      forwarded = next;
      return new Response("ok", { headers: { "content-type": "text/html" } });
    });
    expect(forwarded).toBe(request);
  });

  it("releases the held invocation when the render throws", async () => {
    const ctx = context();
    await expect(keepRenderingAfterDisconnect(new Request(`${ORIGIN}/ja`), ctx, async () => {
      throw new Error("render failed");
    })).rejects.toThrow("render failed");
    await Promise.all(ctx.pending);
  });
});
