import { describe, expect, it, vi } from "vitest";

vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));

// ルートは nextUrl ではなく request.url を見るため、生の Request で検証で
// きる (NextRequest の組み立て環境に依存しない)。
import { GET } from "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/sign-in-with/route";

const request = (search: string) =>
  new Request(`http://localhost:3000/en/account/native-auth/sign-in-with${search}`);

const authUri =
  "https://beutl.beditor.net/account/native-auth/handler?identifier=abc";

describe("native-auth sign-in-with route (desktop social handoff)", () => {
  it("hands the desktop social flow to the client-driven sign-in page with the provider preset", async () => {
    const response = await GET(
      request(
        `?provider=Google&returnUrl=${encodeURIComponent(authUri)}`,
      ) as never,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/en/account/sign-in");
    expect(location.searchParams.get("provider")).toBe("google");
    // 返り先 (createAuthUri の auth_uri) は同ページへそのまま渡り、
    // OAuth callbackURL とサインイン後の戻り先の両方になる。
    expect(location.searchParams.get("returnUrl")).toBe(authUri);
  });

  it("accepts GitHub in PascalCase like the desktop sends", async () => {
    const response = await GET(
      request(`?provider=GitHub&returnUrl=${encodeURIComponent(authUri)}`) as never,
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("provider")).toBe("github");
    expect(location.searchParams.get("returnUrl")).toBe(authUri);
  });

  it("keeps the returnUrl intact even when it is not a native-auth URL", async () => {
    const other = "https://beutl.beditor.net/ja/dashboard";
    const response = await GET(
      request(
        `?provider=Google&returnUrl=${encodeURIComponent(other)}`,
      ) as never,
    );

    // 返り先の検証と自動開始可否はサインインページ側が担う。ここでは
    // 手を加えず接続するだけにして、検証を二重化しない。
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("returnUrl")).toBe(other);
  });

  it("does not auto-start for unknown providers", async () => {
    const response = await GET(
      request(`?provider=Line&returnUrl=${encodeURIComponent(authUri)}`) as never,
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.has("provider")).toBe(false);
    expect(location.searchParams.get("returnUrl")).toBe(authUri);
  });

  it("still hands off with no provider at all", async () => {
    const response = await GET(
      request(`?returnUrl=${encodeURIComponent(authUri)}`) as never,
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.has("provider")).toBe(false);
    expect(location.searchParams.get("returnUrl")).toBe(authUri);
  });
});
