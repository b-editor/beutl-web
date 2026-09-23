import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAiImageEdit } from "../../apps/web/src/lib/ai-image-edit-request";

function editForm(): FormData {
  const form = new FormData();
  form.set("task", "restyle");
  form.set("model", "openai/gpt-image-2");
  form.set("prompt", "Make the center blue");
  form.set("file", new File([Uint8Array.of(1, 2, 3)], "source.png", {
    type: "image/png",
  }));
  return form;
}

describe("dashboard image edit request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated dashboard API route with the original multipart file and key", async () => {
    const fetch = vi.fn(async () => Response.json({
      jobId: "job-1",
      url: "https://beutl.example/api/contents/file-1",
      fileName: "ai-edit-job-1.png",
      contentType: "image/png",
    }));
    vi.stubGlobal("fetch", fetch);
    const form = editForm();
    const outcome = await submitAiImageEdit(form, "edit-key-1");

    expect(outcome).toEqual({
      ok: true,
      jobId: "job-1",
      url: "https://beutl.example/api/contents/file-1",
      fileName: "ai-edit-job-1.png",
      contentType: "image/png",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/internal/ai/images/edit");
    expect(init.method).toBe("POST");
    expect(init.headers.get("Idempotency-Key")).toBe("edit-key-1");
    expect(init.headers.get("x-beutl-internal")).toBe("1");
    expect(init.body).toBe(form);
    expect((init.body.get("file") as File).size).toBe(3);
  });

  it.each([
    [409, "aiRequestInProgress", true],
    [409, "aiRequestChanged", true],
    [500, "aiProviderError", false],
    [500, "aiProviderBillingUnavailable", false],
    [400, "aiModelUnavailable", false],
  ] as const)("maps %s %s without losing a recoverable request", async (
    status,
    errorCode,
    keepIdempotencyKey,
  ) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error_code: errorCode },
      { status },
    )));
    expect(await submitAiImageEdit(editForm(), "edit-key-1"))
      .toEqual({ ok: false, errorCode, keepIdempotencyKey });
  });

  it("keeps the key after a lost or malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection lost"); }));
    expect(await submitAiImageEdit(editForm(), "edit-key-1")).toEqual({
      ok: false,
      errorCode: "aiRequestInterrupted",
      keepIdempotencyKey: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    expect(await submitAiImageEdit(editForm(), "edit-key-1")).toEqual({
      ok: false,
      errorCode: "aiRequestInterrupted",
      keepIdempotencyKey: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url: "missing job" })));
    expect(await submitAiImageEdit(editForm(), "edit-key-1")).toEqual({
      ok: false,
      errorCode: "aiRequestInterrupted",
      keepIdempotencyKey: true,
    });
  });
});
