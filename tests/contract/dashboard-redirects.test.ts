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
    ["/ja/storage/:path*", "/ja/dashboard/storage/:path*"],
    ["/en/storage/:path*", "/en/dashboard/storage/:path*"],
    ["/library/:path*", "/dashboard/library/:path*"],
    ["/ja/library/:path*", "/ja/dashboard/library/:path*"],
    ["/en/library/:path*", "/en/dashboard/library/:path*"],
    ["/developer/:path*", "/dashboard/developer/:path*"],
    ["/ja/developer/:path*", "/ja/dashboard/developer/:path*"],
    ["/en/developer/:path*", "/en/dashboard/developer/:path*"],
    // AI プランの画面が請求ページへ統合されたあとも、発行済みの Checkout
    // success_url / ポータル return_url が戻ってこられるようにする。
    ["/dashboard/account/ai-plan", "/dashboard/account/billing"],
    ["/ja/dashboard/account/ai-plan", "/ja/dashboard/account/billing"],
    ["/en/dashboard/account/ai-plan", "/en/dashboard/account/billing"],
    ["/account/manage/:path*", "/dashboard/account/:path*"],
    ["/ja/account/manage/:path*", "/ja/dashboard/account/:path*"],
    ["/en/account/manage/:path*", "/en/dashboard/account/:path*"],
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

  it("ロケール接頭辞を制約付きパラメータで書かない", () => {
    // vinext 1.0.1 は `/:lang(ja|en)/...` の後半を固定文字列として照合するため、
    // `:path*` を含む旧 URL が一致しなくなる。接頭辞は言語ごとに書き出す。
    for (const redirect of redirects) {
      expect(redirect.source).not.toMatch(/^\/:[\w-]+\(/u);
    }
  });

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
