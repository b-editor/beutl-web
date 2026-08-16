import { describe, expect, it, afterEach } from "vitest";
import worker, { type Env } from "../../packages/api/src/worker";

// 独立 Worker (beutl-web-api) は workerd 上で動くため、vars/secrets は
// env バインディングとして渡され、process.env には自動投入されない。
// worker.ts の fetch が文字列バインディングを process.env へコピーすることを
// 検証する。v1/account (JWT) と v1/app (バージョン) は process.env を直接
// 参照するため、このコピーが無いと独立 Worker で undefined になる。
// DB に依存しない v2/identity/signInWith (リダイレクトのみ) を経由して検証する。

const originalEnv = { ...process.env };

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
      OPENROUTER_TRANSLATION_MODEL: "openai/translation-model",
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
    expect(process.env.OPENROUTER_TRANSLATION_MODEL).toBe(
      "openai/translation-model",
    );
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
