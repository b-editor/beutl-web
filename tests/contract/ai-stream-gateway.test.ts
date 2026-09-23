import { beforeEach, describe, expect, it, vi } from "vitest";

// The session the browser's cookie stands for. The gateway's whole job is to
// turn that into a token for the AI API, so the session is what is mocked.
const getSession = vi.hoisted(() => vi.fn());
const getImageWorkerBinding = vi.hoisted(() => vi.fn());
vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/ai-image-worker-binding", () => ({ getImageWorkerBinding }));

// Stands in for the AI API so the gateway can be watched on its own: a real
// Hono app, because the route mounts what it is given.
const forwarded = vi.hoisted(() => [] as Request[]);
const forwardedPrepared = vi.hoisted(() => [] as boolean[]);
vi.mock("@beutl/api", async () => {
  const { Hono } = await import("hono");
  return {
    v3: new Hono().all("/*", (c) => {
      forwarded.push(c.req.raw);
      forwardedPrepared.push((c.env as { AI_IMAGE_PREPARED_OUTPAINT?: boolean })?.AI_IMAGE_PREPARED_OUTPAINT === true);
      return new Response("ok", {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  };
});

import { POST } from "../../apps/web/src/app/api/internal/ai/[...route]/route";
import { INTERNAL_REQUEST_HEADER } from "../../apps/web/src/lib/internal-request";

const SITE = "http://localhost:3000";

function post(headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request(`${SITE}/api/internal/ai/translations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ targetLanguage: "ja", segments: [] }),
    ...(signal ? { signal } : {}),
  });
}

describe("the dashboard's way in to the AI API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getImageWorkerBinding.mockReturnValue(null);
    process.env.JWT_SECRET = "test-secret-for-the-gateway";
    process.env.AI_IMAGE_WORKER_JWT_SECRET = "test-secret-for-image-worker";
    forwarded.length = 0;
    forwardedPrepared.length = 0;
    getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("passes a signed-in request on with a token of its own", async () => {
    const response = await POST(post({ [INTERNAL_REQUEST_HEADER]: "1" }));

    expect(response.status).toBe(200);
    const request = forwarded[0]!;
    expect(new URL(request.url).pathname).toBe("/api/v3/ai/translations");
    expect(request.headers.get("authorization")).toMatch(/^Bearer \S+$/);
    // The cookie has done its work here and has no business going further.
    expect(request.headers.get("cookie")).toBeNull();
    expect(forwardedPrepared).toEqual([false]);
  });

  it("keeps browser cancellation connected to the forwarded API request", async () => {
    const controller = new AbortController();
    await POST(post({ [INTERNAL_REQUEST_HEADER]: "1" }, controller.signal));

    const request = forwarded[0]!;
    expect(request.signal.aborted).toBe(false);

    controller.abort(new DOMException("page reloaded", "AbortError"));

    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toMatchObject({ name: "AbortError" });
  });

  it("streams image edits to the isolated service after session authentication", async () => {
    const serviceFetch = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ jobId: "image-job" });
    });
    getImageWorkerBinding.mockReturnValue({ fetch: serviceFetch });
    const request = new Request(`${SITE}/api/internal/ai/images/edit`, {
      method: "POST",
      headers: {
        [INTERNAL_REQUEST_HEADER]: "1",
        cookie: "session=private",
        "content-type": "multipart/form-data; boundary=test",
      },
      body: "image body stream",
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(new URL(forwarded[0]!.url).pathname).toBe("/api/v3/ai/images/edit");
    expect(getImageWorkerBinding).toHaveBeenCalledOnce();
    expect(serviceFetch).toHaveBeenCalledOnce();
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0]!.url).pathname).toBe("/api/v3/ai/images/edit");
    expect(forwarded[0]!.headers.get("authorization")).toMatch(/^Bearer \S+$/);
    const token = forwarded[0]!.headers.get("authorization")!.slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(claims).toMatchObject({ iss: "beutl-web-image-edit", aud: "beutl-ai-images" });
    expect(forwarded[0]!.headers.get("cookie")).toBeNull();
    expect(await forwarded[0]!.text()).toBe("image body stream");
  });

  it("keeps the prepared outpaint contract in local Next development", async () => {
    const request = new Request(`${SITE}/api/internal/ai/images/edit`, {
      method: "POST",
      headers: { [INTERNAL_REQUEST_HEADER]: "1" },
      body: "prepared image body stream",
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(forwardedPrepared).toEqual([true]);
    expect(new URL(forwarded[0]!.url).pathname).toBe("/api/v3/ai/images/edit");
  });

  it("does not run a production image edit in Web when the service binding is missing", async () => {
    getImageWorkerBinding.mockImplementation(() => {
      throw new Error("AI_IMAGE_WORKER service binding is missing");
    });
    const request = new Request(`${SITE}/api/internal/ai/images/edit`, {
      method: "POST",
      headers: { [INTERNAL_REQUEST_HEADER]: "1" },
      body: "image body stream",
    });

    await expect(POST(request)).rejects.toThrow("AI_IMAGE_WORKER service binding is missing");
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a request that does not carry this site's own header", async () => {
    // A form on another site can post to this path with the visitor's cookie —
    // it cannot set a header, which is what makes that post refusable.
    const response = await POST(post());

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a request that says it came from somewhere else", async () => {
    const response = await POST(
      post({ [INTERNAL_REQUEST_HEADER]: "1", origin: "https://evil.example" }),
    );

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a request with no session behind it", async () => {
    getSession.mockResolvedValue(null);

    const response = await POST(post({ [INTERNAL_REQUEST_HEADER]: "1" }));

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("names the user the session names, and only for a minute", async () => {
    await POST(post({ [INTERNAL_REQUEST_HEADER]: "1", origin: SITE }));

    const token = forwarded[0]!.headers.get("authorization")!.slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"]).toBe(
      "user-1",
    );
    expect(claims.exp - claims.iat).toBe(60);
  });
});
