import { describe, expect, it } from "vitest";
import { Hono } from "hono";

// v2/identity/signInWith は NextResponse.redirect (デフォルト 307) の単一リダイレクトシム。
// Hono 化する際は c.redirect(url, 307) を明示してこの契約を維持する。

describe("v2 signInWith リダイレクト契約", () => {
  it("307 かつ Location ヘッダで native-auth フローへ誘導する", async () => {
    const app = new Hono().get("/", (c) => {
      const url = new URL(c.req.url);
      const provider = url.searchParams.get("provider") ?? "";
      const returnUrl = url.searchParams.get("returnUrl") ?? "";
      const lang = "ja";
      const target = new URL(`/${lang}/account/native-auth/sign-in-with`, url.origin);
      target.searchParams.set("provider", provider);
      target.searchParams.set("returnUrl", returnUrl);
      return c.redirect(target, 307);
    });

    const res = await app.request(
      "/?provider=github&returnUrl=" + encodeURIComponent("https://beutl.beditor.net/"),
    );
    expect(res.status).toBe(307);
    // Location は同一オリジン + native-auth フローへのパス (ステータス 307 が契約本体)
    const location = res.headers.get("location") ?? "";
    const loc = new URL(location);
    expect(loc.pathname).toBe("/ja/account/native-auth/sign-in-with");
    expect(loc.searchParams.get("provider")).toBe("github");
    expect(loc.searchParams.get("returnUrl")).toBe("https://beutl.beditor.net/");
  });
});

describe("v3 app/updates エラー契約", () => {
  it("invalidRequestBody エラーエンベロープを 400 で返す", async () => {
    const app = new Hono().get("/updates/:version", (c) => {
      const version = c.req.param("version");
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        return c.json(
          { error_code: "invalidRequestBody", message: "", documentation_url: null },
          { status: 400 },
        );
      }
      return c.json({ ok: true });
    });

    const res = await app.request("/updates/invalid", { headers: { host: "beutl.beditor.net" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_code: "invalidRequestBody",
      documentation_url: null,
    });
  });
});
