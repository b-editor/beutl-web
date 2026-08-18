import { describe, expect, it } from "vitest";

// ファイルパスの URL 化を固定する。
//
// Beutl のプロジェクトは日本語や空白を含む名前になりやすく、`#` `?` `%` も入りうる。
// href 側でエンコードを忘れると `#` 以降がフラグメント扱いになって行き先がずれ、
// 受け取り側で余計にデコードすると `100%.txt` のような名前で URIError になる。
// Next.js の dynamic params は既にデコード済みで渡ってくる (実機で確認済み)。

import { encodeRepositoryPath, joinRouteSegments } from "@beutl/forgejo";

describe("encodeRepositoryPath", () => {
  it("区切りの / は残す", () => {
    expect(encodeRepositoryPath("assets/clips/take01.mov")).toBe(
      "assets/clips/take01.mov",
    );
  });

  it("空白と日本語をエンコードする", () => {
    expect(encodeRepositoryPath("素材 一覧/日本語 a.scene")).toBe(
      "%E7%B4%A0%E6%9D%90%20%E4%B8%80%E8%A6%A7/%E6%97%A5%E6%9C%AC%E8%AA%9E%20a.scene",
    );
  });

  it("URL の意味を持つ文字をエスケープする", () => {
    expect(encodeRepositoryPath("a#b.txt")).toBe("a%23b.txt");
    expect(encodeRepositoryPath("q?x=1.txt")).toBe("q%3Fx%3D1.txt");
    expect(encodeRepositoryPath("100%.txt")).toBe("100%25.txt");
  });

  it("エンコードした結果は元に戻せる", () => {
    for (const path of ["100%.txt", "a#b/c d.scene", "素材/logo.svg"]) {
      expect(decodeURIComponent(encodeRepositoryPath(path))).toBe(path);
    }
  });
});

describe("joinRouteSegments", () => {
  it("デコードせずに繋ぐだけ", () => {
    // Next が渡してくるのはデコード済みの値。ここで decodeURIComponent すると
    // % を含む名前で URIError になる。
    expect(joinRouteSegments(["100%.txt"])).toBe("100%.txt");
    expect(joinRouteSegments(["素材", "日本語 a.scene"])).toBe(
      "素材/日本語 a.scene",
    );
    expect(() => joinRouteSegments(["50%off.png"])).not.toThrow();
  });
});
