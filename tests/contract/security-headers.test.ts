import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  securityHeaders,
} from "@beutl/next/security-headers";

// CSP 文字列をディレクティブ単位に分ける。同一ポリシー内で同名ディレクティブを
// 二度書くと最初の一度しか採用されないため、「一度しか出現しないこと」自体が契約。
function directivesOf(csp: string): string[] {
  return csp.split(";").map((d) => d.trim()).filter(Boolean);
}

function directive(csp: string, name: string): string {
  const found = directivesOf(csp).find((d) => d.startsWith(`${name} `));
  expect(found, `directive ${name} in "${csp}"`).toBeTruthy();
  return found!;
}

describe("contentSecurityPolicy", () => {
  it("keeps the strict baseline in production", () => {
    const csp = contentSecurityPolicy({ NODE_ENV: "production" });

    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    // Next.js App Router の inline bootstrap script が走るため unsafe-inline は
    // 許す (nonce は OpenNext の R2 キャッシュ済み HTML を殺すので採用しない)。
    // static.cloudflareinsights.com はゾーン設定でエッジから注入される RUM
    // ビーコンで、コード側では出せないため許す。
    expect(directive(csp, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
    );
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    // markdown 本文の任意 img URL とプロバイダのアバターを https: で許容する。
    // blob: は AI 面のローカルファイルのプレビュー (URL.createObjectURL) 用。
    expect(directive(csp, "img-src")).toBe("img-src 'self' https: data: blob:");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    // blob: は動画/音声のプレビューとメタデータ取得 (ai-video-duration.ts が
    // video 要素に createObjectURL を渡す) 用。
    expect(directive(csp, "media-src")).toBe("media-src 'self' blob:");
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://cloudflareinsights.com",
    );
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    // form-action はフォーム送信のリダイレクト先にも適用されるため、課金
    // フォームの 303 先 (Stripe Checkout と請求ポータル) を許す。
    expect(directive(csp, "form-action")).toBe(
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    );

    // 本番ビルドで eval は出ない。
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("allows the configured direct-upload origin", () => {
    const csp = contentSecurityPolicy({
      NODE_ENV: "production",
      STORAGE_ORIGIN: "https://s3.example.test",
    });

    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://cloudflareinsights.com https://s3.example.test",
    );
    expect(directivesOf(csp).filter((d) => d.startsWith("connect-src "))).toHaveLength(1);
  });

  it("allows the preview's signaling origin without opening other WebSocket origins", () => {
    const csp = contentSecurityPolicy({
      NODE_ENV: "production",
      WEBSOCKET_ORIGIN: "wss://beutl.beditor.net",
    });

    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://cloudflareinsights.com wss://beutl.beditor.net",
    );
  });

  it("adds eval only for the dev bundle, without duplicating script-src", () => {
    const dev = contentSecurityPolicy({ NODE_ENV: "development" });

    expect(directive(dev, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
  });

  it("emits each directive at most once", () => {
    for (const NODE_ENV of ["production", "development"] as const) {
      const names = directivesOf(contentSecurityPolicy({ NODE_ENV })).map(
        (d) => d.split(" ")[0],
      );
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("securityHeaders", () => {
  it("sets the response headers every page should carry", () => {
    const headers = securityHeaders({ NODE_ENV: "production" });

    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });
});

describe("applySecurityHeaders", () => {
  it("adds every header to a bare response", () => {
    const response = applySecurityHeaders(new Response(null));

    expect(response.headers.get("Content-Security-Policy")).toBe(
      contentSecurityPolicy({ NODE_ENV: "production" }),
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("respects headers the response already carries", () => {
    // /api/contents (ダウンロード/プレビュー配信) は自前で strict CSP と
    // nosniff を付ける。middleware は除外されているが、将来の構成変更で
    // 重なっても既存の値を壊さないこと。
    const response = applySecurityHeaders(
      new Response(null, {
        headers: {
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
        },
      }),
    );

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // 既存値を尊重しながら、その他のヘッダーはすべて付く。
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });
});

describe("wiring", () => {
  it("exposes the module from @beutl/next", async () => {
    const source = await readFile(new URL("../../packages/next/package.json", import.meta.url), "utf8");
    expect(source).toContain('"./security-headers"');
  });

  it("wraps the web middleware, keeping the api and _next exclusions", async () => {
    const middleware = await readFile(new URL("../../apps/web/src/middleware.ts", import.meta.url), "utf8");
    expect(middleware).toContain("applySecurityHeaders(oversized ?? localeMiddleware(request), {");
    expect(middleware).toContain("STORAGE_ORIGIN: storageOrigin()");
    expect(middleware).toContain(String.raw`"/((?!_next|api/|\\.well-known/).*)"`);
  });

  it("wraps the admin middleware, keeping the api and _next exclusions", async () => {
    const middleware = await readFile(new URL("../../apps/admin/src/middleware.ts", import.meta.url), "utf8");
    expect(middleware).toContain("applySecurityHeaders(localeMiddleware(request))");
    expect(middleware).toContain('"/((?!_next|api/).*)"');
  });

  it.each(["../../apps/web/next.config.mjs", "../../apps/admin/next.config.mjs"])(
    "adds HSTS for /api in %s",
    async (configPath) => {
      const source = await readFile(new URL(configPath, import.meta.url), "utf8");
      expect(source).toContain('source: "/api/:path*"');
      expect(source).toContain('key: "Strict-Transport-Security"');
      expect(source).toContain("max-age=31536000; includeSubDomains");
      // 重複で効力を失うヘッダーは /api の構成に入れない (contents 自前分と
      // 重なっても安全な HSTS と Referrer-Policy のみ)。
      expect(source).toContain('key: "Referrer-Policy"');
      expect(source).not.toContain('key: "X-Content-Type-Options"');
      expect(source).not.toContain('key: "X-Frame-Options"');
    },
  );
});
