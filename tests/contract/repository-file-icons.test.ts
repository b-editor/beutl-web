import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GITATTRIBUTES_TEMPLATE } from "@beutl/forgejo";

// ファイル一覧のアイコン対応表 (file-tree.tsx) が、.gitattributes で LFS に
// 載せている拡張子を網羅しているかを見る。漏れると素材が汎用ファイルのアイコンで
// 並ぶ。実際に svg / フォント / LUT が漏れていた。
//
// アイコン選択はサーバーコンポーネントの中の定数なので、import せずにソースから読む。
// 表示にしか関わらないため、これ以上の作り込みはしない。

const SOURCE = readFileSync(
  join(
    process.cwd(),
    "apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/[owner]/[repo]/file-tree.tsx",
  ),
  "utf8",
);

// テンプレートは大文字小文字を問わず拾うため *.[mM][pP]4 と書いてある。
// 比較しやすいよう小文字の拡張子に戻す。
function toPlainExtension(pattern: string): string {
  return pattern.replace(/\[(\w)\w\]/g, (_, lower: string) => lower);
}

function lfsExtensions(): string[] {
  return [...GITATTRIBUTES_TEMPLATE.matchAll(/^\*\.(\S+)\s+filter=lfs/gm)].map(
    (match) => toPlainExtension(match[1]),
  );
}

function iconExtensions(): string[] {
  const table = SOURCE.slice(
    SOURCE.indexOf("const ICONS_BY_EXTENSION"),
    SOURCE.indexOf("function iconFor"),
  );
  return [...table.matchAll(/"([a-z0-9 ]+)":/g)].flatMap((match) =>
    match[1].split(" ").filter(Boolean),
  );
}

describe("ファイル一覧のアイコン", () => {
  it("LFS 対象の拡張子を取り出せている (テストの前提)", () => {
    const extensions = lfsExtensions();
    expect(extensions).toContain("mp4");
    expect(extensions).toContain("cube");
    expect(extensions.length).toBeGreaterThan(20);
  });

  it("LFS 対象のうちアイコンが割り当てられていないものを列挙する", () => {
    // LUT (.cube) だけは意図的に汎用アイコン。見た目を表す適切なアイコンがない。
    const intentionallyGeneric = new Set(["cube"]);
    const missing = lfsExtensions().filter(
      (extension) =>
        !iconExtensions().includes(extension) &&
        !intentionallyGeneric.has(extension),
    );

    expect(missing).toEqual([]);
  });

  it("アイコン表に LFS 対象でない拡張子を混ぜない", () => {
    const lfs = lfsExtensions();
    const stray = iconExtensions().filter(
      (extension) => !lfs.includes(extension),
    );

    expect(stray).toEqual([]);
  });
});
