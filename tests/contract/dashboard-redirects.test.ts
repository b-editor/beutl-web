import { describe, expect, it } from "vitest";
// @ts-expect-error next.config から読まれる純データの .mjs で、型定義は持たない。
import { dashboardRedirects } from "../../apps/web/next.redirects.mjs";

type Redirect = {
  source: string;
  destination: string;
  permanent: boolean;
};

// /storage, /library, /developer, /account/manage を /dashboard 配下へ移した際の
// 旧 URL 互換を固定する。next.config.mjs の redirects() は localeMiddleware より
// 先に走るため、ロケール接頭辞なし (既定の ja は rewrite で届く) と接頭辞あり
// (/en/...) の両系統が必要になる。
describe("旧 URL から /dashboard へのリダイレクト", () => {
  const redirects = dashboardRedirects() as Redirect[];

  // source → destination を 1 件ずつ固定する。移設先を後から変えるときは、
  // 旧 URL を指しているブックマークやメールのリンクが壊れないか、この表で確かめる。
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ["/storage/:path*", "/dashboard/storage/:path*"],
    ["/:lang(ja|en)/storage/:path*", "/:lang/dashboard/storage/:path*"],
    ["/library/:path*", "/dashboard/library/:path*"],
    ["/:lang(ja|en)/library/:path*", "/:lang/dashboard/library/:path*"],
    ["/developer/:path*", "/dashboard/developer/:path*"],
    ["/:lang(ja|en)/developer/:path*", "/:lang/dashboard/developer/:path*"],
    // AI プランの画面が請求ページへ統合されたあとも、発行済みの Checkout
    // success_url / ポータル return_url が戻ってこられるようにする。
    ["/dashboard/account/ai-plan", "/dashboard/account/billing"],
    [
      "/:lang(ja|en)/dashboard/account/ai-plan",
      "/:lang/dashboard/account/billing",
    ],
    ["/account/manage/:path*", "/dashboard/account/:path*"],
    ["/:lang(ja|en)/account/manage/:path*", "/:lang/dashboard/account/:path*"],
  ];

  it("対応表がそのまま登録されている", () => {
    expect(redirects.map((r) => [r.source, r.destination])).toEqual(
      EXPECTED.map(([source, destination]) => [source, destination]),
    );
  });

  for (const [source, destination] of EXPECTED) {
    it(`${source} → ${destination}`, () => {
      expect(redirects).toContainEqual({
        source,
        destination,
        permanent: false,
      });
    });
  }

  it("permanent を立てない (307 のまま)", () => {
    // 308 をブラウザにキャッシュさせると、確認メールのリンクのような一回性 URL の
    // 挙動を後から変えられなくなる。
    for (const redirect of redirects) {
      expect(redirect.permanent).toBe(false);
    }
  });

  it("送信済みメールが指す確認 URL を取りこぼさない", () => {
    // /account/manage/email?token=... と
    // /account/manage/personal-data/handle?token=... は送信済みの確認メールに
    // 埋まっている。ConfirmationToken.expires を過ぎるまで外してはいけない。
    const accountRule = redirects.find(
      (r) => r.source === "/account/manage/:path*",
    );
    expect(accountRule).toBeDefined();
    expect(accountRule?.destination).toBe("/dashboard/account/:path*");
  });
});
