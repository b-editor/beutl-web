import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiStream } from "../../apps/web/src/lib/ai-event-stream";
import { eventStreamResponse } from "../../packages/api/src/ai/sse";
import {
  aiRequestNameOf, commitAiRequestName, keepsIdempotencyKey,
  newAiRequestNames, readyAiRequestNames, settleAiRequestName,
} from "../../apps/web/src/lib/ai-screen";

const RESULT = { jobId: "job-1", segments: [{ id: "line-1", text: "こんにちは" }] };
const run = (onEvent = vi.fn()) => runAiStream("translations", {
  body: "{}", idempotencyKey: "request-1", onEvent,
});
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("reading AI results in the dashboard", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

  it.each([
    [504, "<html>Gateway Timeout</html>"],
    [502, ""],
    [500, JSON.stringify({ error_code: "unknown" })],
    [500, JSON.stringify({ error_code: "" })],
    [500, "{}"],
  ])("retains the paid request identity after ambiguous HTTP %s (%s)", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    let names = readyAiRequestNames(newAiRequestNames(), () => "original-key");
    names = commitAiRequestName(names, "same-request", () => "next-key");
    const outcome = await run();
    expect(outcome).toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
    if (outcome.ok) throw new Error("Expected an interrupted request");
    names = settleAiRequestName(names, keepsIdempotencyKey(outcome.errorCode));
    expect(aiRequestNameOf(names, "same-request")).toBe("original-key");
  });

  it.each(["aiProviderError", "aiProviderBillingUnavailable"])(
    "keeps a confirmed refunded failure terminal: %s", async (error_code) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code }, { status: 500 })));
      await expect(run()).resolves.toEqual({ ok: false, errorCode: error_code });
    },
  );

  it("does not invent a provider failure for a malformed terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(event("error", {}), {
      headers: { "content-type": "text/event-stream" },
    })));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
  });
  it.each(["futureFailure", "unknown", "invalidRequestBody", "aiPlanRequired", "aiRequestInProgress"])("keeps the recovery key for an unconfirmed streamed error: %s", async (error_code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(event("error", { error_code }), {
      headers: { "content-type": "text/event-stream" },
    })));
    const result = await run();
    expect(result).toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
    if (!result.ok) expect(keepsIdempotencyKey(result.errorCode)).toBe(true);
  });
  it.each(["aiProviderError", "aiProviderBillingUnavailable"])("accepts a confirmed streamed provider failure: %s", async (error_code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(event("error", { error_code }), {
      headers: { "content-type": "text/event-stream" },
    })));
    await expect(run()).resolves.toEqual({ ok: false, errorCode: error_code });
  });
  it.each([[400, "futureFailure"], [402, "unknown"], [409, "futureFailure"], [429, ""]])(
    "treats an unrecognized HTTP %s error as interrupted: %s", async (status, error_code) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code }, { status: status as number })));
      await expect(run()).resolves.toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
    },
  );
  it.each([[400, "invalidRequestBody"], [402, "aiPlanRequired"], [413, "fileIsTooLarge"], [409, "aiRequestChanged"]])(
    "preserves recognized pre-stream HTTP %s refusals: %s", async (status, error_code) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code }, { status: status as number })));
      await expect(run()).resolves.toEqual({ ok: false, errorCode: error_code });
    },
  );

  it.each([false, true])("retains the request after an unhandled server stream failure (preview=%s)", async (preview) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = eventStreamResponse(async (emit) => {
      if (preview) emit("segment", RESULT.segments[0]);
      // In particular, the operation's refund transaction can itself reject.
      throw new Error("Refund transaction failed");
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    let names = readyAiRequestNames(newAiRequestNames(), () => "original-key");
    names = commitAiRequestName(names, "same-request", () => "next-key");
    const outcome = await run();
    expect(outcome).toEqual({ ok: false, errorCode: "aiRequestInterrupted" });
    if (outcome.ok) throw new Error("Expected an interrupted request");
    names = settleAiRequestName(names, keepsIdempotencyKey(outcome.errorCode));
    expect(aiRequestNameOf(names, "same-request")).toBe("original-key");
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
