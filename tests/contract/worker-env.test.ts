import { describe, expect, it, afterEach, vi } from "vitest";
import { sign } from "hono/jwt";
import worker, {
  requestBodyLimitForWorker,
  type Env,
} from "../../packages/api/src/worker";
import {
  MAX_API_JSON_REQUEST_BYTES,
  MAX_OPENROUTER_CALLBACK_BODY_BYTES,
  aiScreenUploadLimit,
} from "@beutl/core";
import { aiApiMultipartBodyLimit } from "../../packages/api/src/ai/upload-limits";

// The test must reach the multipart parser through the real Worker route. Keep
// the pre-parse database lookups local so the body-limit assertion is not tied
// to a live database or entitlement catalog.
vi.mock("../../packages/api/src/ai/credits", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/credits")
  >();
  return {
    ...actual,
    aiJobStateForIdempotencyKey: vi.fn().mockResolvedValue("none"),
  };
});
vi.mock("../../packages/api/src/ai/entitlements", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/entitlements")
  >();
  return {
    ...actual,
    getEntitlements: vi.fn().mockResolvedValue({ canUseAi: true }),
  };
});

// 独立 Worker (beutl-web-api) は workerd 上で動くため、vars/secrets は
// env バインディングとして渡され、process.env には自動投入されない。
// worker.ts の fetch が文字列バインディングを process.env へコピーすることを
// 検証する。v1/account (JWT) と v1/app (バージョン) は process.env を直接
// 参照するため、このコピーが無いと独立 Worker で undefined になる。
// DB に依存しない v2/identity/signInWith (リダイレクトのみ) を経由して検証する。

const originalEnv = { ...process.env };

async function expectFileTooLarge(response: Response): Promise<void> {
  expect(response.status).toBe(413);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual({
    error_code: "fileIsTooLarge",
    message: expect.any(String),
    documentation_url: null,
  });
}

describe("worker.ts env → process.env コピー", () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it("文字列バインディング (vars/secrets) を process.env にコピーする", async () => {
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
      JWT_SECRET: "test-secret",
      JWT_ISSUER: "https://beutl.beditor.net",
      JWT_AUDIENCE: "beutl",
      PUBLIC_ORIGIN: "https://beutl.beditor.net",
    } satisfies Env;

    const res = await worker.fetch(
      new Request(
        "https://beutl.beditor.net/api/v2/identity/signInWith?provider=github",
        { headers: { host: "beutl.beditor.net" } },
      ),
      env as any,
    );

    expect(res.status).toBe(307);
    expect(process.env.JWT_SECRET).toBe("test-secret");
    expect(process.env.JWT_ISSUER).toBe("https://beutl.beditor.net");
    expect(process.env.JWT_AUDIENCE).toBe("beutl");
    expect(process.env.PUBLIC_ORIGIN).toBe("https://beutl.beditor.net");
  });

  it("非文字列バインディング (Hyperdrive) は process.env にコピーしない", async () => {
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
    };

    await worker.fetch(
      new Request(
        "https://beutl.beditor.net/api/v2/identity/signInWith?provider=github",
        { headers: { host: "beutl.beditor.net" } },
      ),
      env as any,
    );

    expect(process.env.BEUTL_DATABASE_HYPERDRIVE).toBeUndefined();
  });
});

describe("worker request body route limits", () => {
  async function authorizationHeader() {
    const token = await sign(
      {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
          "worker-upload-limit-user",
        exp: Math.floor(Date.now() / 1_000) + 300,
      },
      "worker-upload-limit-secret",
      "HS256",
    );
    return `Bearer ${token}`;
  }

  function oversizedMultipartBody(boundary: string) {
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    );
    const targetBytes = aiApiMultipartBodyLimit("/api/v3/ai/transcriptions")! + 1;
    const chunkSize = 64 * 1024;
    let emitted = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 0) {
          emitted += prefix.byteLength;
          controller.enqueue(prefix);
          return;
        }
        if (emitted < targetBytes) {
          const size = Math.min(chunkSize, targetBytes - emitted);
          emitted += size;
          controller.enqueue(new Uint8Array(size));
          return;
        }
        controller.close();
      },
    });
  }

  function multipartBodyOfSize(boundary: string, targetBytes: number) {
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    let emitted = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted < prefix.byteLength) {
          const end = Math.min(prefix.byteLength, targetBytes);
          controller.enqueue(prefix.subarray(emitted, end));
          emitted = end;
          return;
        }
        if (emitted < targetBytes) {
          const size = Math.min(64 * 1024, targetBytes - emitted);
          emitted += size;
          controller.enqueue(new Uint8Array(size));
          return;
        }
        controller.close();
      },
    });
  }

  it("keeps small JSON routes small and AI uploads at their endpoint limits", () => {
    expect(
      requestBodyLimitForWorker(
        "POST",
        "/api/v1/account/createAuthUri",
        "application/json",
      ),
    ).toBe(MAX_API_JSON_REQUEST_BYTES);
    expect(
      requestBodyLimitForWorker(
        "POST",
        "/api/v3/ai/transcriptions",
        "multipart/form-data; boundary=x",
      ),
    ).toBe(aiApiMultipartBodyLimit("/api/v3/ai/transcriptions"));
    expect(
      requestBodyLimitForWorker(
        "POST",
        "/api/v3/ai/images/edit",
        "multipart/form-data; boundary=x",
      ),
    ).toBe(aiApiMultipartBodyLimit("/api/v3/ai/images/edit"));
    for (const pathname of [
      "/api/v1/account/refresh",
      "/api/v1/account/code2jwt",
      "/api/v3/account/library",
      "/api/v3/user/ai-availability",
    ]) {
      expect(requestBodyLimitForWorker("POST", pathname, null)).toBe(
        MAX_API_JSON_REQUEST_BYTES,
      );
      expect(requestBodyLimitForWorker("POST", pathname, "text/plain")).toBe(
        MAX_API_JSON_REQUEST_BYTES,
      );
    }
    expect(
      requestBodyLimitForWorker(
        "POST",
        "/api/v3/ai/videos/123/openrouter-callback",
        "text/plain",
      ),
    ).toBe(MAX_OPENROUTER_CALLBACK_BODY_BYTES);
    expect(requestBodyLimitForWorker("POST", "/api/v3/unknown", "application/json"))
      .toBe(MAX_API_JSON_REQUEST_BYTES);
    expect(requestBodyLimitForWorker("POST", "/api/v3/unknown", "text/plain"))
      .toBe(MAX_API_JSON_REQUEST_BYTES);
  });

  it.each([
    "/api/v3/ai/images",
    "/api/v3/ai/images/edit",
    "/api/v3/ai/transcriptions",
    "/api/v3/ai/videos/frames",
  ])("accepts the exact canonical multipart cap and rejects cap+1 for %s", async (pathname) => {
    const boundary = `worker-cap-${pathname.split("/").at(-1)}`;
    const cap = aiApiMultipartBodyLimit(pathname)!;
    const headers = {
      authorization: await authorizationHeader(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };
    const exact = await worker.fetch(
      new Request(`https://beutl.beditor.net${pathname}`, {
        method: "POST",
        headers,
        body: multipartBodyOfSize(boundary, cap),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
        JWT_SECRET: "worker-upload-limit-secret",
      } satisfies Env,
    );
    expect(exact.status).not.toBe(413);

    const over = await worker.fetch(
      new Request(`https://beutl.beditor.net${pathname}`, {
        method: "POST",
        headers,
        body: multipartBodyOfSize(boundary, cap + 1),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
        JWT_SECRET: "worker-upload-limit-secret",
      } satisfies Env,
    );
    await expectFileTooLarge(over);
  });

  it("keeps the standalone transcription cap below the dashboard action-state cap", () => {
    expect(aiApiMultipartBodyLimit("/api/v3/ai/transcriptions")!).toBeLessThan(
      aiScreenUploadLimit("/dashboard/ai/transcribe")!,
    );
  });

  it("maps a chunked createAuthUri body over the cap to 413", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"continue_uri":"https://beutl.beditor.net/?x=${"a".repeat(40_000)}"}`));
        controller.close();
      },
    });
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
    } satisfies Env;

    const response = await worker.fetch(
      new Request("https://beutl.beditor.net/api/v1/account/createAuthUri", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      env,
    );

    await expectFileTooLarge(response);
  });

  it.each(["-1", "1.5", "not-a-number"])(
    "rejects invalid declared Content-Length %s at the standalone boundary",
    async (contentLength) => {
      const response = await worker.fetch(
        new Request("https://beutl.beditor.net/api/v1/account/createAuthUri", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": contentLength,
          },
          body: "{}",
        }),
        {
          BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
        } satisfies Env,
      );
      await expectFileTooLarge(response);
    },
  );

  it("ignores a forged low Content-Length while API downstream consumes the body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"continue_uri":"https://beutl.beditor.net/?x=${"a".repeat(40_000)}"}`));
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request("https://beutl.beditor.net/api/v1/account/createAuthUri", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      { BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" } } as Env,
    );
    await expectFileTooLarge(response);
  });

  it.each([
    ["without Content-Length", undefined],
    ["with a forged low Content-Length", "1"],
  ])(
    "maps an oversized chunked multipart transcription through worker.fetch to 413 (%s)",
    async (_description, contentLength) => {
      const boundary = "worker-upload-limit-boundary";
      const headers = new Headers({
        authorization: await authorizationHeader(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      });
      if (contentLength !== undefined) {
        headers.set("content-length", contentLength);
      }
      const response = await worker.fetch(
        new Request("https://beutl.beditor.net/api/v3/ai/transcriptions", {
          method: "POST",
          headers,
          body: oversizedMultipartBody(boundary),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
        {
          BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
          JWT_SECRET: "worker-upload-limit-secret",
        } satisfies Env,
      );

      await expectFileTooLarge(response);
    },
  );

  it("keeps an early unauthenticated response without draining a chunked body", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(40_000));
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request("https://beutl.beditor.net/api/v3/ai/transcriptions", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      { BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" } } as Env,
    );
    expect(response.status).toBe(401);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("caps the real OpenRouter callback route at its 64 KiB body limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70 * 1024));
        controller.close();
      },
    });
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://test" },
    } satisfies Env;
    const response = await worker.fetch(
      new Request(
        "https://beutl.beditor.net/api/v3/ai/videos/job-1/openrouter-callback",
        { method: "POST", body, duplex: "half" } as RequestInit & {
          duplex: "half";
        },
      ),
      env,
    );
    await expectFileTooLarge(response);
  });
});
