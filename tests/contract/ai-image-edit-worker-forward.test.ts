import { afterEach, describe, expect, it, vi } from "vitest";
import { verify } from "hono/jwt";
import { forwardImageEditToAiApiWorker } from "../../apps/web/src/lib/ai-image-edit-worker";

const USER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

function editForm(key = "test-image-edit-1"): FormData {
  const form = new FormData();
  form.set("task", "restyle");
  form.set("model", "openai/gpt-image-2");
  form.set("prompt", "Make the center blue");
  form.set("file", new File([Uint8Array.of(1, 2, 3)], "source.png", {
    type: "image/png",
  }));
  form.set("idempotencyKey", key);
  return form;
}

async function forward(
  fetch: (request: Request) => Promise<Response>,
  formData = editForm(),
) {
  return await forwardImageEditToAiApiWorker({
    worker: { fetch },
    userId: "user-1",
    origin: "https://beutl.example",
    formData,
  });
}

describe("dashboard image edit API Worker forwarding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards the original multipart request with a short-lived signed user token", async () => {
    vi.stubEnv("JWT_SECRET", "test-image-worker-secret");
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
    let sent: Request | undefined;
    const result = await forward(async (request) => {
      sent = request;
      return Response.json({
        jobId: "job-1",
        url: "https://beutl.example/api/contents/file-1",
        fileName: "ai-edit-job-1.png",
        contentType: "image/png",
      });
    });

    expect(result).toEqual({
      ok: true,
      jobId: "job-1",
      url: "https://beutl.example/api/contents/file-1",
      fileName: "ai-edit-job-1.png",
      contentType: "image/png",
    });
    expect(sent?.url).toBe("https://beutl.example/api/v3/ai/images/edit");
    expect(sent?.headers.get("Idempotency-Key")).toBe("test-image-edit-1");
    const token = sent?.headers.get("Authorization")?.replace(/^Bearer /u, "");
    expect(token).toBeTruthy();
    expect(await verify(token!, "test-image-worker-secret", { alg: "HS256" }))
      .toMatchObject({ [USER_CLAIM]: "user-1" });
    const body = await sent?.formData();
    expect(body?.get("model")).toBe("openai/gpt-image-2");
    expect(new Uint8Array(await (body?.get("file") as File).arrayBuffer()))
      .toEqual(Uint8Array.of(1, 2, 3));
  });

  it.each([
    [409, "aiRequestInProgress", true],
    [409, "aiRequestChanged", true],
    [500, "aiProviderError", false],
    [500, "aiProviderBillingUnavailable", false],
    [400, "aiModelUnavailable", false],
  ] as const)("maps %s %s without discarding a paid request", async (
    status,
    errorCode,
    keepIdempotencyKey,
  ) => {
    vi.stubEnv("JWT_SECRET", "test-image-worker-secret");
    expect(await forward(async () => Response.json(
      { error_code: errorCode },
      { status },
    ))).toEqual({ ok: false, errorCode, keepIdempotencyKey });
  });

  it("retains the key when the service fails after possibly accepting the job", async () => {
    vi.stubEnv("JWT_SECRET", "test-image-worker-secret");
    expect(await forward(async () => { throw new Error("connection lost"); }))
      .toEqual({ ok: false, errorCode: "aiRequestInterrupted", keepIdempotencyKey: true });
    expect(await forward(async () => new Response("upstream unavailable", { status: 503 })))
      .toEqual({ ok: false, errorCode: "aiRequestInterrupted", keepIdempotencyKey: true });
  });

  it("rejects a malformed key without sending an API request", async () => {
    vi.stubEnv("JWT_SECRET", "test-image-worker-secret");
    const fetch = vi.fn(async () => Response.json({ jobId: "unexpected" }));
    expect(await forward(fetch, editForm("bad\nkey"))).toEqual({
      ok: false,
      errorCode: "invalidRequestBody",
      keepIdempotencyKey: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
