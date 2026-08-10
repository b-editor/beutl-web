import { describe, expect, it } from "vitest";
import { resolveSafeRedirectPath } from "@beutl/core";

const ORIGIN = "https://admin.beutl.beditor.net";

describe("resolveSafeRedirectPath", () => {
  it("同一オリジンの相対パスを正規化して返す", () => {
    expect(resolveSafeRedirectPath("/ja/admin", ORIGIN)).toBe("/ja/admin");
    expect(resolveSafeRedirectPath("/ja/admin?q=1#top", ORIGIN)).toBe(
      "/ja/admin?q=1#top",
    );
  });

  it("同一オリジンの絶対 URL はパスへ正規化する", () => {
    expect(resolveSafeRedirectPath(`${ORIGIN}/ja/admin`, ORIGIN)).toBe(
      "/ja/admin",
    );
  });

  // startsWith("/") だけの検証を通過してしまう既知のオープンリダイレクト経路。
  it.each([
    "//evil.com",
    "//evil.com/ja/admin",
    "/\\evil.com",
    "/\t/evil.com",
  ])("プロトコル相対・バックスラッシュ経由の外部遷移を拒否する: %s", (url) => {
    expect(resolveSafeRedirectPath(url, ORIGIN)).toBeNull();
  });

  // ドットセグメントは URL 解決時に畳まれるため、入力が "/" 始まりでも
  // 正規化後のパスが "//evil.com" になりうる。オリジン比較だけでは通過する。
  it.each([
    "/..//evil.com",
    "/../\\evil.com",
    "/a/../..//evil.com",
    "/ja/../..//evil.com/path",
  ])(
    "正規化でプロトコル相対パスになる入力を拒否する: %s",
    (url) => {
      expect(resolveSafeRedirectPath(url, ORIGIN)).toBeNull();
      expect(resolveSafeRedirectPath(url)).toBeNull();
    },
  );

  it("別オリジンの絶対 URL を拒否する", () => {
    expect(resolveSafeRedirectPath("https://evil.com", ORIGIN)).toBeNull();
    expect(
      resolveSafeRedirectPath("https://evil.com/ja/admin", ORIGIN),
    ).toBeNull();
  });

  it("http/https 以外のスキームを拒否する", () => {
    expect(resolveSafeRedirectPath("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(resolveSafeRedirectPath("data:text/html,x", ORIGIN)).toBeNull();
  });

  it("空・未指定を拒否する", () => {
    expect(resolveSafeRedirectPath(undefined, ORIGIN)).toBeNull();
    expect(resolveSafeRedirectPath(null, ORIGIN)).toBeNull();
    expect(resolveSafeRedirectPath("", ORIGIN)).toBeNull();
  });

  it("オリジン未指定時は相対パスのみ受理する", () => {
    expect(resolveSafeRedirectPath("/ja/admin")).toBe("/ja/admin");
    expect(resolveSafeRedirectPath("//evil.com")).toBeNull();
    expect(resolveSafeRedirectPath(`${ORIGIN}/ja/admin`)).toBeNull();
  });
});

// Next.js は ?returnUrl=/a&returnUrl=/b のような繰り返しクエリを配列で渡す。
// 配列のまま URL へ渡すと "/a,/b" が同一オリジンとして通ってしまう。
describe("resolveSafeRedirectPath (繰り返しクエリ)", () => {
  it("配列は先頭要素だけを採用する", () => {
    expect(resolveSafeRedirectPath(["/ja/admin", "/ja/other"], ORIGIN)).toBe(
      "/ja/admin",
    );
  });

  it("先頭要素が外部オリジンなら拒否する", () => {
    expect(
      resolveSafeRedirectPath(["https://evil.example/", "/ja/admin"], ORIGIN),
    ).toBeNull();
  });

  it("空配列は null", () => {
    expect(resolveSafeRedirectPath([], ORIGIN)).toBeNull();
  });
});
