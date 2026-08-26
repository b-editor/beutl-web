import { boundedBody, requestBodyLimit } from "@beutl/core";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

type WorkerContext = unknown;
type WorkerEnvironment = unknown;
type DownstreamFetch = (
  request: Request,
  env: WorkerEnvironment,
  context: WorkerContext,
) => Promise<Response>;

function tooLargeResponse(): Response {
  return new Response(null, { status: 413 });
}

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

  const limit = requestBodyLimit(new URL(request.url).pathname);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > limit) return tooLargeResponse();
  }

  let bodyLimitExceeded = false;
  const headers = new Headers(request.headers);
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
    return bodyLimitExceeded ? tooLargeResponse() : response;
  } catch (error) {
    if (bodyLimitExceeded) return tooLargeResponse();
    throw error;
  }
}
