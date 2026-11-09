type AssetFetcher = { fetch(request: Request): Promise<Response> };
type ByteRange = { start: number; end: number };

// Path to size in bytes. A range response has to state the file's total size, and
// the assets binding does not tell the Worker: the runtime adds Content-Length only
// when it sends the response. A contract test holds these to the real files.
//
// showcase.webm stays out: browsers that pick it play without ranges, and listing
// it would send most landing page views through the Worker for nothing.
export const RANGE_SERVED_VIDEOS: ReadonlyMap<string, number> = new Map([
  ["/img/agent-demo.mp4", 16_520_404],
  ["/img/showcase.mp4", 21_227_680],
]);

export function isRangeServedVideo(request: Request): boolean {
  return RANGE_SERVED_VIDEOS.has(new URL(request.url).pathname);
}

/** Null means send the whole file, which a server may always do instead of a range. */
function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(match[1]);
  if (match[2] && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

/** Passes on only the bytes of `range`; terminating also stops the read of the rest of the file. */
function keepRange({ start, end }: ByteRange): TransformStream<Uint8Array, Uint8Array> {
  let position = 0;
  return new TransformStream({
    transform(chunk, controller) {
      const from = Math.max(start - position, 0);
      const to = Math.min(end + 1 - position, chunk.byteLength);
      position += chunk.byteLength;
      if (from < to) controller.enqueue(chunk.subarray(from, to));
      if (position > end) controller.terminate();
    },
  });
}

/** The Workers runtime drops Content-Length from a stream unless the stream declares its length. */
function withKnownLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const { FixedLengthStream } = globalThis as {
    FixedLengthStream?: new (length: number) => ReadableWritablePair<Uint8Array, Uint8Array>;
  };
  return FixedLengthStream ? body.pipeThrough(new FixedLengthStream(length)) : body;
}

/**
 * Answer byte-range requests for a video in the static assets.
 *
 * Workers Static Assets ignores `Range` and always sends the whole file with a
 * 200. Chrome copes, but Apple's media stack treats such a server as
 * misconfigured (AVFoundation -11850), so an MP4 never starts in Safari.
 * `run_worker_first` in wrangler.jsonc routes the paths above here.
 *
 * The bytes are streamed, not read into memory: the showcase starts on its own,
 * so these are ordinary page-view requests, and one Worker instance serving
 * several at once must not hold a copy of the file for each.
 */
export async function serveVideoWithRange(
  request: Request,
  assets: AssetFetcher,
  sizes: ReadonlyMap<string, number> = RANGE_SERVED_VIDEOS,
): Promise<Response> {
  const forwarded = new Headers(request.headers);
  const rangeHeader = request.method === "GET" ? forwarded.get("Range") : null;
  const ifRange = forwarded.get("If-Range");
  forwarded.delete("Range");
  forwarded.delete("If-Range");

  const asset = await assets.fetch(new Request(request.url, { method: request.method, headers: forwarded }));
  const headers = new Headers(asset.headers);
  headers.set("Accept-Ranges", "bytes");
  const whole = () => new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });

  const size = sizes.get(new URL(request.url).pathname);
  if (
    asset.status !== 200 ||
    asset.body === null ||
    size === undefined ||
    rangeHeader === null ||
    (ifRange !== null && ifRange !== asset.headers.get("ETag"))
  ) {
    return whole();
  }

  const range = parseRange(rangeHeader, size);
  if (range === null) return whole();

  if (range === "unsatisfiable") {
    await asset.body.cancel();
    headers.delete("Content-Length");
    headers.delete("Content-Type");
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  const length = range.end - range.start + 1;
  headers.set("Content-Length", String(length));
  return new Response(withKnownLength(asset.body.pipeThrough(keepRange(range)), length), { status: 206, headers });
}
