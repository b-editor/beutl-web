import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiStream } from "../../apps/web/src/lib/ai-event-stream";

const RESULT = { jobId: "job-1", segments: [{ id: "line-1", text: "こんにちは" }] };
const run = (onEvent = vi.fn()) => runAiStream("translations", {
  body: "{}", idempotencyKey: "request-1", onEvent,
});
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("reading AI results in the dashboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the JSON success returned when replaying a completed job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(RESULT)));
    await expect(run()).resolves.toEqual({ ok: true, result: RESULT });
  });

  it.each(["", "not JSON", '{"jobId":"job-1","segments":'])
    ("treats an unreadable successful JSON replay as interrupted: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
        headers: { "content-type": "application/json" },
      })));
      await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
    });

  it("treats a connection failure while reading a successful replay as interrupted", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"jobId":"job-1",'));
        else controller.error(new Error("connection lost"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "application/json" },
    })));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("keeps JSON refusals as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code: "aiRequestInProgress" }, { status: 409 })));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInProgress" });
  });

  it("delivers previews and accepts the terminal result without waiting for a later socket failure", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode(event("segment", RESULT.segments[0]) + event("result", RESULT)));
        } else {
          controller.error(new Error("connection closed after the result"));
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })));
    const onEvent = vi.fn();
    await expect(run(onEvent)).resolves.toEqual({ ok: true, result: RESULT });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith("segment", RESULT.segments[0]);
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reports an interrupted stream before a terminal event (socket error=%s)", async (fail) => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(event("segment", RESULT.segments[0])));
        else if (fail) controller.error(new Error("connection lost"));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });

  it("keeps a terminal provider error even if another result follows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      event("error", { error_code: "aiProviderError" }) + event("result", RESULT),
      { headers: { "content-type": "text/event-stream" } },
    )));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiProviderError" });
  });
});
