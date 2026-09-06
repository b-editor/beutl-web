import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiRequest } from "../../apps/web/src/lib/ai-request";
import { INTERNAL_REQUEST_HEADER } from "../../apps/web/src/lib/internal-request";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browser's non-streaming AI request", () => {
  it("posts JSON with the request identity and returns the API result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: "video-1", status: "queued" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runAiRequest<{ id: string; status: string }>("videos", {
        body: JSON.stringify({ prompt: "waves" }),
        idempotencyKey: "video-request-1",
      }),
    ).resolves.toEqual({
      ok: true,
      result: { id: "video-1", status: "queued" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/internal/ai/videos");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ prompt: "waves" }));
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("video-request-1");
    expect(headers.get(INTERNAL_REQUEST_HEADER)).toBe("1");
  });

  it("keeps multipart encoding browser-owned and maps an API error_code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        { error_code: "aiJobLimitReached", message: "busy" },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.set("prompt", "waves");

    await expect(
      runAiRequest("videos/frames", {
        body,
        idempotencyKey: "video-request-2",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiJobLimitReached" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/internal/ai/videos/frames");
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it.each([
    ["invalid JSON", new Response("<html>not json</html>", { status: 200 })],
    [
      "an oversized JSON body",
      new Response(JSON.stringify({ value: "x".repeat(64 * 1024) }), {
        status: 200,
      }),
    ],
  ])("marks a successful response containing %s as interrupted", async (
    _name,
    response,
  ) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      runAiRequest("videos", {
        body: "{}",
        idempotencyKey: "video-request-malformed",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("treats an unreadable response as an interrupted request", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 200 },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      runAiRequest("videos", {
        body: "{}",
        idempotencyKey: "video-request-unreadable",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("does not invent a terminal error when an error response has no error_code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ message: "gateway failed" }, { status: 502 }),
      ),
    );

    await expect(
      runAiRequest("videos", {
        body: "{}",
        idempotencyKey: "video-request-error-envelope",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("keeps the request recoverable for a structured unexpected server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error_code: "unknown" }, { status: 500 }),
      ),
    );

    await expect(
      runAiRequest("videos", {
        body: "{}",
        idempotencyKey: "video-request-unexpected-error",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("keeps an explicitly refunded provider failure terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error_code: "aiProviderError" }, { status: 500 }),
      ),
    );

    await expect(
      runAiRequest("videos", {
        body: "{}",
        idempotencyKey: "video-request-provider-failure",
      }),
    ).resolves.toEqual({ ok: false, errorCode: "aiProviderError" });
  });

  it("passes the caller's signal through and preserves abort rejection", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init.signal).toBe(controller.signal);
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = runAiRequest("videos", {
      body: "{}",
      idempotencyKey: "video-request-abort",
      signal: controller.signal,
    });
    controller.abort(new DOMException("stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
