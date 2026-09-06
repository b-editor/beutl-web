// What tells the dashboard's own requests apart from ones another site made
// with the same cookie.
//
// A cookie is sent by the browser whatever page asked for the request, so a
// request that arrives with one has to show it was meant. A form on another
// site can post to these paths — some of them read multipart, which a form can
// produce — but it cannot set a header, and a fetch that sets one is
// preflighted, which none of these paths answer.
export const INTERNAL_REQUEST_HEADER = "x-beutl-internal";

export const INTERNAL_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  [INTERNAL_REQUEST_HEADER]: "1",
};

/**
 * Whether a request carrying the session cookie was made by this site.
 *
 * The header above is what carries the weight. An Origin, when the browser
 * sends one, has to be this site as well — but its absence cannot be treated as
 * a refusal, because Safari omits it on same-origin requests.
 */
export function fromThisSite(request: Request): boolean {
  if (request.headers.get(INTERNAL_REQUEST_HEADER) !== "1") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { error_code: "authenticationIsRequired" },
    { status: 401 },
  );
}

/**
 * Reads a small control body, refusing one that is larger than it should be.
 *
 * These routes take a name and a list of part numbers, nothing more. Reading
 * them with `request.json()` puts no bound on what arrives, and a declared
 * length is not one either: a chunked body carries none. The length is checked
 * where it is known and the read is stopped where it is not.
 */
export async function readJsonWithLimit(
  request: Request,
  maximumBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      return { ok: false };
    }
  }

  const body = request.body;
  if (!body) return { ok: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(joined)) };
  } catch {
    return { ok: false };
  }
}
