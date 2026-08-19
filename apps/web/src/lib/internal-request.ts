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
