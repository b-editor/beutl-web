import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseBytes, readBoundedResponseText } from "@beutl/api/response-body";

vi.mock("@beutl/api", () => {
  throw new Error("Response readers must not load the shared API barrel");
});
vi.mock("@beutl/db", () => {
  throw new Error("Response readers must not load database services");
});
vi.mock("../../packages/api/src/ai/openrouter", () => {
  throw new Error("Response readers must not load the OpenRouter client");
});
vi.mock("../../packages/api/src/ai/providers/vercel-gateway", () => {
  throw new Error("Response readers must not load the Gateway client");
});

describe("bounded response reading", () => {
  it("loads Admin telemetry readers without AI or database dependencies", async () => {
    const errors = await import("../../apps/admin/src/lib/desktop-errors-server");
    const usage = await import("../../apps/admin/src/lib/desktop-usage-server");
    expect(errors.fetchDesktopErrors).toBeTypeOf("function");
    expect(usage.fetchDesktopUsage).toBeTypeOf("function");
  });

  it("decodes split UTF-8 sequences at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("日本語");
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 2));
        controller.enqueue(bytes.subarray(2));
        controller.close();
      },
    }));
    await expect(readBoundedResponseText(response, 9, "Report")).resolves.toBe("日本語");
  });

  it("cancels an oversized declared response before acquiring a reader", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "10" },
    });
    const getReader = vi.spyOn(response.body!, "getReader");
    await expect(readBoundedResponseText(response, 9, "Report"))
      .rejects.toMatchObject({ reason: "size_limit", message: "Report exceeds the size limit" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("bounds streamed bytes with Content-Length %s", async (length) => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(3)); },
      cancel,
    }), { headers: length === undefined ? undefined : { "content-length": length } });
    await expect(readBoundedResponseBytes(response, 5, "Report"))
      .rejects.toMatchObject({ reason: "size_limit" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts responses without a body", async () => {
    await expect(readBoundedResponseText(new Response(null), 0, "Report")).resolves.toBe("");
  });

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    await expect(readBoundedResponseText(new Response(Uint8Array.of(0xff)), 1, "Report"))
      .rejects.toMatchObject({ reason: "encoding", message: "Report is not valid UTF-8" });
  });

  it("distinguishes an interrupted stream from oversized output", async () => {
    const cause = new TypeError("connection reset");
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(cause); },
    }));
    await expect(readBoundedResponseBytes(response, 100, "Report"))
      .rejects.toMatchObject({ reason: "read", cause });
  });
});
