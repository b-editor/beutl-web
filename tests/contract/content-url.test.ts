import { describe, expect, it, afterEach } from "vitest";
import { getContentUrl } from "@beutl/api";

// content-url の origin 解決順序を固定する契約テスト。
// デスクトップ API は絶対 URL (https://beutl.beditor.net/api/contents/<id>) を返す必要がある。

const originalEnv = { ...process.env };

describe("getContentUrl (origin 解決)", () => {
  afterEach(() => {
    // PUBLIC_ORIGIN のテスト間リークを防ぐ
    if (originalEnv.PUBLIC_ORIGIN === undefined) {
      delete process.env.PUBLIC_ORIGIN;
    } else {
      process.env.PUBLIC_ORIGIN = originalEnv.PUBLIC_ORIGIN;
    }
  });

  it("id が null/undefined なら null を返す", async () => {
    expect(await getContentUrl(null)).toBeNull();
    expect(await getContentUrl(undefined)).toBeNull();
  });

  it("PUBLIC_ORIGIN env があればそれを最優先で使う", async () => {
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
    expect(await getContentUrl("file-1")).toBe(
      "https://beutl.beditor.net/api/contents/file-1",
    );
  });

  it("env が無ければ request の origin を使う", async () => {
    delete process.env.PUBLIC_ORIGIN;
    const request = new Request("https://beutl.beditor.net/api/v3/files/abc", {
      headers: { host: "beutl.beditor.net" },
    });
    expect(await getContentUrl("file-1", request)).toBe(
      "https://beutl.beditor.net/api/contents/file-1",
    );
  });
});
