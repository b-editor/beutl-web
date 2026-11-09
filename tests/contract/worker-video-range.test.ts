import { readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isRangeServedVideo, RANGE_SERVED_VIDEOS, serveVideoWithRange } from "../../apps/web/src/lib/worker-video-range";

const PATH = "/img/agent-demo.mp4";
const URL_PATH = `https://beutl.beditor.net${PATH}`;
const FILE = new TextEncoder().encode("0123456789");
const ETAG = '"demo"';
const SIZES = new Map([[PATH, FILE.length]]);

function inChunks(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
      if (offset >= bytes.length) controller.close();
    },
  });
}

function assetsAnswering(status = 200) {
  const seen: Request[] = [];
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push(request);
      // Like the real binding, this reports no Content-Length.
      return new Response(status === 200 && request.method === "GET" ? inChunks(FILE, 3) : null, {
        status,
        headers: { "Content-Type": "video/mp4", ETag: ETAG },
      });
    },
  };
}

async function serve(headers: Record<string, string>, method = "GET", assets = assetsAnswering()) {
  const response = await serveVideoWithRange(new Request(URL_PATH, { method, headers }), assets, SIZES);
  return { response, text: await response.text() };
}

describe("serveVideoWithRange", () => {
  it("sends the whole file and advertises ranges without a Range header", async () => {
    const { response, text } = await serve({});

    expect(response.status).toBe(200);
    expect(text).toBe("0123456789");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it.each([
    ["bytes=0-1", "01", "bytes 0-1/10"],
    ["bytes=2-7", "234567", "bytes 2-7/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
    ["bytes=0-9", "0123456789", "bytes 0-9/10"],
  ])("answers %s with the requested bytes", async (range, expected, contentRange) => {
    const { response, text } = await serve({ Range: range });

    expect(response.status).toBe(206);
    expect(text).toBe(expected);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(expected.length));
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("ETag")).toBe(ETAG);
  });

  it("stops reading the asset once the range has been sent", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const assets = {
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(1000));
            },
            cancel,
          }),
        ),
    };

    const response = await serveVideoWithRange(
      new Request(URL_PATH, { headers: { Range: "bytes=0-1" } }),
      assets,
      new Map([[PATH, 1_000_000]]),
    );

    expect((await response.arrayBuffer()).byteLength).toBe(2);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(pulls).toBeLessThan(10);
  });

  it("answers a range past the end with 416 and the file size", async () => {
    const { response } = await serve({ Range: "bytes=10-" });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
  });

  it.each(["bytes=0-1,4-5", "bytes=5-2", "items=0-1", "bytes=-"])("sends the whole file for %s", async (range) => {
    const { response, text } = await serve({ Range: range });

    expect(response.status).toBe(200);
    expect(text).toBe("0123456789");
  });

  it("honors If-Range only for the current ETag", async () => {
    const current = await serve({ Range: "bytes=0-1", "If-Range": ETAG });
    const stale = await serve({ Range: "bytes=0-1", "If-Range": '"older"' });

    expect(current.response.status).toBe(206);
    expect(stale.response.status).toBe(200);
    expect(stale.text).toBe("0123456789");
  });

  it("does not forward the range to the assets, which would ignore it", async () => {
    const assets = assetsAnswering();

    await serve({ Range: "bytes=0-1", "If-Range": ETAG }, "GET", assets);

    expect(assets.seen[0].headers.has("Range")).toBe(false);
    expect(assets.seen[0].headers.has("If-Range")).toBe(false);
  });

  it("passes a HEAD request and an asset that is not 200 through", async () => {
    const head = await serve({ Range: "bytes=0-1" }, "HEAD");
    const missing = await serve({ Range: "bytes=0-1" }, "GET", assetsAnswering(404));
    const unchanged = await serve({ Range: "bytes=0-1" }, "GET", assetsAnswering(304));

    expect(head.response.status).toBe(200);
    expect(head.response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(missing.response.status).toBe(404);
    expect(unchanged.response.status).toBe(304);
  });
});

describe("the route to serveVideoWithRange", () => {
  // Without run_worker_first, static assets answer before the Worker and the code above never runs.
  it.each(["/img/agent-demo.mp4", "/img/showcase.mp4"])("sends %s to the Worker ahead of the static assets", (path) => {
    const config = readFileSync(new URL("../../apps/web/wrangler.jsonc", import.meta.url), "utf8");
    const listed = /"run_worker_first":\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";

    expect(listed).toContain(`"${path}"`);
    expect(isRangeServedVideo(new Request(`https://beutl.beditor.net${path}`))).toBe(true);
  });

  it.each([...RANGE_SERVED_VIDEOS])("states the real size of %s", (path, size) => {
    expect(statSync(new URL(`../../apps/web/public${path}`, import.meta.url)).size).toBe(size);
  });

  it("leaves the WebM to the static assets", () => {
    expect(isRangeServedVideo(new Request("https://beutl.beditor.net/img/showcase.webm"))).toBe(false);
  });
});
