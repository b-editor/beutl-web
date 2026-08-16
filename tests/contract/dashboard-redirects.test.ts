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

  const OLD_PREFIXES = [
    "/storage",
    "/library",
    "/developer",
    "/account/manage",
  ] as const;

  it("4 パターンをロケール接頭辞あり / なしの両方で持つ", () => {
    expect(redirects).toHaveLength(OLD_PREFIXES.length * 2);
  });

  for (const prefix of OLD_PREFIXES) {
    it(`${prefix} が接頭辞なしと /:lang(ja|en) の両方で登録されている`, () => {
      expect(redirects).toContainEqual(
        expect.objectContaining({ source: `${prefix}/:path*` }),
      );
      expect(redirects).toContainEqual(
        expect.objectContaining({ source: `/:lang(ja|en)${prefix}/:path*` }),
      );
    });
  }

  it("すべての行き先が /dashboard 配下を指す", () => {
    for (const redirect of redirects) {
      expect(redirect.destination).toMatch(
        /^(\/dashboard\/|\/:lang\/dashboard\/)/,
      );
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
