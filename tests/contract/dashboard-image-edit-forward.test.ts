import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("@/lib/auth-guard", () => ({
  throwIfUnauth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@beutl/next/language", () => ({
  getLanguage: vi.fn(async () => "en"),
}));
vi.mock("@beutl/i18n", () => ({
  getTranslation: vi.fn(async () => ({ t: (key: string) => key })),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({
    "x-url": "https://beutl.example/dashboard/ai/edit",
  })),
}));

const getContext = vi.hoisted(() => vi.fn());
let editImageAction: typeof import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions")
  .editImageAction;

beforeAll(async () => {
  const requireFromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(requireFromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: getContext,
  }));
  ({ editImageAction } = await import(
    "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions"
  ));
});

function editForm(): FormData {
  const form = new FormData();
  form.set("task", "restyle");
  form.set("model", "openai/gpt-image-2");
  form.set("prompt", "Make the center blue");
  // The Web Worker must not decode this upload; the API Worker validates it.
  form.set("file", new File([Uint8Array.of(1, 2, 3)], "source.png", {
    type: "image/png",
  }));
  form.set("idempotencyKey", "dashboard-image-edit-test");
  return form;
}

describe("dashboard image edit isolation", () => {
  beforeEach(() => {
    getContext.mockReset();
    vi.stubEnv("JWT_SECRET", "dashboard-image-edit-test-secret");
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the API Worker before the Web Worker decodes or reserves the image", async () => {
    const fetch = vi.fn(async () => Response.json({
      jobId: "api-job-1",
      url: "https://beutl.example/api/contents/file-1",
      fileName: "ai-edit-api-job-1.png",
      contentType: "image/png",
    }));
    getContext.mockResolvedValue({ env: { BEUTL_API_WORKER: { fetch } } });

    expect(await editImageAction({ success: false }, editForm())).toMatchObject({
      success: true,
      jobId: "api-job-1",
      url: "https://beutl.example/api/contents/file-1",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves the key after an ambiguous API Worker transport failure", async () => {
    getContext.mockResolvedValue({
      env: { BEUTL_API_WORKER: { fetch: async () => { throw new Error("lost response"); } } },
    });

    expect(await editImageAction({ success: false }, editForm())).toMatchObject({
      success: false,
      message: "api-errors:aiRequestInterrupted",
      keepIdempotencyKey: true,
    });
  });

  it("keeps prepared outpainting on its existing validation path", async () => {
    const form = editForm();
    form.set("task", "outpaint");
    expect(await editImageAction({ success: false }, form)).toMatchObject({
      success: false,
      message: "api-errors:invalidRequestBody",
    });
    expect(getContext).not.toHaveBeenCalled();
  });
});
