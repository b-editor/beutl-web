// Sending an answer while it is still being worked out.
//
// A caller asks for this with `Accept: text/event-stream`, and everything that
// can be refused before the work starts — an unusable request, a plan that does
// not cover it, a duplicate — is still refused with an ordinary status code and
// JSON body. The stream begins only once the work does, because a status code
// cannot be taken back after the first byte of the body has gone out.
//
// What travels over it is the work in progress and then, always, one closing
// event: `result` when the operation produced what it was asked for, `error`
// when it did not. A reader that sees neither has been cut off.

export type SseEmitter = (event: string, data: unknown) => void;

// Some proxies close a connection that says nothing for long enough, and the
// gap between an image's rough versions can be tens of seconds. A comment line
// is not an event, so a reader ignores it.
const HEARTBEAT_INTERVAL_MS = 15_000;

export function eventStreamRequested(request: Request): boolean {
  const accept = request.headers.get("accept");
  return accept !== null && accept.toLowerCase().includes("text/event-stream");
}

export function eventStreamResponse(
  run: (emit: SseEmitter) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader has gone. The work still finishes and is still recorded,
          // because it has already been paid for.
          open = false;
        }
      };
      const heartbeat = setInterval(
        () => write(": keep-alive\n\n"),
        HEARTBEAT_INTERVAL_MS,
      );

      void (async () => {
        try {
          await run((event, data) =>
            write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch (error) {
          // Whatever the operation failed to say for itself. The caller's own
          // error handling has already run by the time anything gets here.
          console.error("Unhandled failure in an AI event stream", error);
          write(
            `event: error\ndata: ${JSON.stringify({
              error_code: "aiProviderError",
            })}\n\n`,
          );
        } finally {
          clearInterval(heartbeat);
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed by a reader that left.
          }
        }
      })();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // Nothing between here and the reader may hold the events back or
      // rewrite them: a proxy that buffers or compresses the body would deliver
      // the whole answer at once, which is the one thing this is not for.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
