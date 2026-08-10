import { describe, expect, it } from "vitest";
import { resolveNativeAuthContinueTarget } from "@beutl/core";

const ORIGIN = "https://beutl.beditor.net";

describe("resolveNativeAuthContinueTarget", () => {
  it("同一オリジンの遷移先はパスへ正規化する", () => {
    expect(
      resolveNativeAuthContinueTarget("/ja/account/native-auth/handler", ORIGIN),
    ).toBe("/ja/account/native-auth/handler");
    expect(
      resolveNativeAuthContinueTarget(
        `${ORIGIN}/ja/account/native-auth/handler?identifier=x`,
        ORIGIN,
      ),
    ).toBe("/ja/account/native-auth/handler?identifier=x");
  });

  // デスクトップアプリはローカルの待ち受け URL を渡すため、同一オリジン判定だけでは
  // ネイティブサインインが同意画面で行き止まりになる。
  it("許可ホストの別オリジン URL は絶対 URL のまま通す", () => {
    expect(
      resolveNativeAuthContinueTarget("http://localhost:5000/callback", ORIGIN),
    ).toBe("http://localhost:5000/callback");
  });

  it("許可リスト外のホストは拒否する", () => {
    expect(
      resolveNativeAuthContinueTarget("https://evil.example/", ORIGIN),
    ).toBeNull();
    expect(
      resolveNativeAuthContinueTarget("https://beditor.net/", ORIGIN),
    ).toBeNull();
    // "//evil.example" は origin 相対として解決されるため同一オリジン判定で弾かれる。
    expect(resolveNativeAuthContinueTarget("//evil.example", ORIGIN)).toBeNull();
  });

  it("http/https 以外のスキームは拒否する", () => {
    expect(
      resolveNativeAuthContinueTarget("javascript:alert(1)", ORIGIN),
    ).toBeNull();
    expect(
      resolveNativeAuthContinueTarget("beutl://localhost/callback", ORIGIN),
    ).toBeNull();
  });

  it("未指定は null", () => {
    expect(resolveNativeAuthContinueTarget(undefined, ORIGIN)).toBeNull();
    expect(resolveNativeAuthContinueTarget("", ORIGIN)).toBeNull();
  });
});
