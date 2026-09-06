import { boundedBody, requestBodyLimit } from "@beutl/core";
import { fileTooLargeApiResponse } from "@beutl/api/error";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

type WorkerContext = unknown;
type WorkerEnvironment = unknown;
type DownstreamFetch = (
  request: Request,
  env: WorkerEnvironment,
  context: WorkerContext,
) => Promise<Response>;

/** Guard an OpenNext request before its generated handler buffers the body. */
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
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      return await fileTooLargeApiResponse();
    }
  }

  let bodyLimitExceeded = false;
  const headers = new Headers(request.headers);
  // Do not trust a declared length after wrapping the stream. OpenNext buffers
  // the bounded stream and restores Content-Length from the actual byte count;
  // the storage part route therefore still receives the exact length it needs.
  headers.delete("content-length");
  const bounded = new Request(request.url, {
    method: request.method,
    headers,
    body: boundedBody(request.body, limit, () => {
      bodyLimitExceeded = true;
    }),
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
