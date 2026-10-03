import { boundedBody, requestBodyLimit } from "@beutl/core";
import { fileTooLargeApiResponse } from "@beutl/api/error";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

type WorkerContext = unknown;
type WorkerEnvironment = unknown;
// workerd's FixedLengthStream hands on a stream whose length is known. Node
// (tests, tooling) has none.
type FixedLengthStreamConstructor = new (
  length: number,
) => TransformStream<Uint8Array, Uint8Array>;

type DownstreamFetch = (
  request: Request,
  env: WorkerEnvironment,
  context: WorkerContext,
) => Promise<Response>;

/** Guard a request before vinext or a route handler reads its body. */
export async function fetchWithBodyLimit(
  request: Request,
  env: WorkerEnvironment,
  context: WorkerContext,
  downstream: DownstreamFetch,
): Promise<Response> {
  if (BODYLESS_METHODS.has(request.method) || !request.body) {
    return await downstream(request, env, context);
  }

  const limit = requestBodyLimit(
    new URL(request.url).pathname,
    request.method,
    request.headers.get("content-type"),
  );
  const declared = request.headers.get("content-length");
  let length: number | undefined;
  if (declared !== null) {
    length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      return await fileTooLargeApiResponse();
    }
  }

  let bodyLimitExceeded = false;
  // Count what actually arrives, against the declared length when there is one,
  // so a low Content-Length cannot carry more than it claims.
  let body = boundedBody(request.body, length ?? limit, () => {
    bodyLimitExceeded = true;
  });
  // A stream built here has no length of its own, and vinext hands bodies on
  // without buffering them. Restore the declared length so a storage part still
  // reaches the bucket, which only takes a stream it can measure.
  const FixedLength = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor })
    .FixedLengthStream;
  if (length !== undefined && typeof FixedLength === "function") {
    body = body.pipeThrough(new FixedLength(length));
  }
  const bounded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  try {
    const response = await downstream(bounded, env, context);
    return bodyLimitExceeded ? await fileTooLargeApiResponse() : response;
  } catch (error) {
    if (bodyLimitExceeded) return await fileTooLargeApiResponse();
    throw error;
  }
}
