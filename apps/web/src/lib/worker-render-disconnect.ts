const RENDER_METHODS = new Set(["GET", "HEAD"]);
const RENDER_CONTENT_TYPES = ["text/html", "text/x-component"];

type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
type DownstreamFetch = (request: Request) => Promise<Response>;

/** Route handlers only; they may use request APIs after the response closes. */
function isRouteHandlerPath(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/");
}

function isPageRender(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return RENDER_CONTENT_TYPES.some((renderType) => type.startsWith(renderType));
}

/**
 * Let a page render finish after the visitor leaves.
 *
 * `enable_request_signal` aborts `request.signal` when the client disconnects,
 * and OpenNext then closes the Next response. Next keeps rendering anyway, but
 * a closed response runs `after()` callbacks — the Prisma `$disconnect` — and
 * rejects every later `headers()` / `cookies()` call in that render. So an
 * HTML or RSC response never hears about the disconnect: once the visitor
 * leaves or the client cancels the body, the rest is read into nothing and
 * Next closes the response itself when the render is done. Waiting for the
 * client instead would hold `waitUntil` forever when the runtime drops a late
 * response unread, and the runtime cancels that as a hung Worker.
 *
 * `/api/*` keeps the original signal from the start, so file contents stop
 * even before their headers; other GET responses that turn out not to be a
 * render (redirects, images) get the disconnect once they begin. POST keeps the
 * original signal for AI submissions.
 */
export async function keepRenderingAfterDisconnect(
  request: Request,
  context: WorkerContext,
  downstream: DownstreamFetch,
): Promise<Response> {
  if (!RENDER_METHODS.has(request.method) || isRouteHandlerPath(request)) {
    return await downstream(request);
  }

  // Held from the start: a visitor can leave before the render's first byte.
  let settle!: () => void;
  context.waitUntil(new Promise<void>((resolve) => { settle = resolve; }));

  const disconnect = new AbortController();
  let response: Response;
  try {
    response = await downstream(new Request(request, { signal: disconnect.signal }));
  } catch (error) {
    settle();
    throw error;
  }
  if (!isPageRender(response) || !response.body) {
    settle();
    const forward = () => disconnect.abort(request.signal.reason);
    if (request.signal.aborted) forward();
    else request.signal.addEventListener("abort", forward, { once: true });
    return response;
  }

  // Read the render as it arrives, whatever the client does; OpenNext's own
  // stream already buffers without limit.
  const reader = response.body.getReader();
  let client!: ReadableStreamDefaultController<Uint8Array>;
  let forwarding = true;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { client = controller; },
    cancel() { forwarding = false; },
  });
  const closeClient = () => {
    if (!forwarding) return;
    forwarding = false;
    client.close();
  };
  if (request.signal.aborted) closeClient();
  else request.signal.addEventListener("abort", closeClient, { once: true });

  void (async () => {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (forwarding) client.enqueue(chunk.value);
      }
      closeClient();
    } catch (error) {
      // The body itself failed, not the client; pass that on if anyone listens.
      if (forwarding) {
        forwarding = false;
        client.error(error);
      }
    }
  })().finally(settle);
  return new Response(readable, response);
}
