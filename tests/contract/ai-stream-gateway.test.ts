import { beforeEach, describe, expect, it, vi } from "vitest";

// The session the browser's cookie stands for. The gateway's whole job is to
// turn that into a token for the AI API, so the session is what is mocked.
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession } } }));

// Stands in for the AI API so the gateway can be watched on its own: a real
// Hono app, because the route mounts what it is given.
const forwarded = vi.hoisted(() => [] as Request[]);
vi.mock("@beutl/api", async () => {
  const { Hono } = await import("hono");
  return {
    v3: new Hono().all("/*", (c) => {
      forwarded.push(c.req.raw);
      return new Response("ok", {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  };
});

import { POST } from "../../apps/web/src/app/api/internal/ai/[...route]/route";
import { AI_STREAM_HEADER } from "../../apps/web/src/lib/ai-event-stream";

const SITE = "http://localhost:3000";

function post(headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/api/internal/ai/translations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ targetLanguage: "ja", segments: [] }),
  });
}

describe("the dashboard's way in to the AI API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret-for-the-gateway";
    forwarded.length = 0;
    getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("passes a signed-in request on with a token of its own", async () => {
    const response = await POST(post({ [AI_STREAM_HEADER]: "1" }));

    expect(response.status).toBe(200);
    const request = forwarded[0]!;
    expect(new URL(request.url).pathname).toBe("/api/v3/ai/translations");
    expect(request.headers.get("authorization")).toMatch(/^Bearer \S+$/);
    // The cookie has done its work here and has no business going further.
    expect(request.headers.get("cookie")).toBeNull();
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
      post({ [AI_STREAM_HEADER]: "1", origin: "https://evil.example" }),
    );

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a request with no session behind it", async () => {
    getSession.mockResolvedValue(null);

    const response = await POST(post({ [AI_STREAM_HEADER]: "1" }));

    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("names the user the session names, and only for a minute", async () => {
    await POST(post({ [AI_STREAM_HEADER]: "1", origin: SITE }));

    const token = forwarded[0]!.headers.get("authorization")!.slice("Bearer ".length);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(
      claims[
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
      ],
    ).toBe("user-1");
    expect(claims.exp - claims.iat).toBe(60);
  });
});
