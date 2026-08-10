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
