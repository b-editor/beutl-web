import { defineConfig } from "vitest/config";
import path from "node:path";

// Vite の alias は「完全一致」か「キー + '/' で始まる」ときにマッチするため、
// バレル (index.ts) を指すエントリだけではサブパス import が
// packages/<name>/src/index.ts/<subpath> という存在しないパスに書き換わる。
// パッケージごとにバレル用とサブパス用の 2 エントリを用意する。
function workspacePackage(name: string) {
  const src = path.resolve(__dirname, "packages", name, "src");
  return [
    {
      find: new RegExp(`^@beutl/${name}$`),
      replacement: path.join(src, "index.ts"),
    },
    { find: new RegExp(`^@beutl/${name}/`), replacement: `${src}/` },
  ];
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, "apps/web/src")}/` },
      // @beutl/ui の exports は ./use-toast を src/hooks/ 配下へ向けており、
      // 下の構造的なサブパス解決 (src/<subpath>) では一致しない。
      {
        find: /^@beutl\/ui\/use-toast$/,
        replacement: path.resolve(
          __dirname,
          "packages/ui/src/hooks/use-toast.ts",
        ),
      },
      ...workspacePackage("api"),
      ...workspacePackage("core"),
      ...workspacePackage("db"),
      ...workspacePackage("email"),
      ...workspacePackage("i18n"),
      // @beutl/next / @beutl/ui はバレルを持たずサブパスのみを公開する。
      {
        find: /^@beutl\/next\//,
        replacement: `${path.resolve(__dirname, "packages/next/src")}/`,
      },
      {
        find: /^@beutl\/ui\//,
        replacement: `${path.resolve(__dirname, "packages/ui/src")}/`,
      },
      // server-only は Next.js 専用パッケージ。契約テストは node 環境で実行するため
      // 空モジュールに解決する。
      {
        find: "server-only",
        replacement: path.resolve(__dirname, "tests/stubs/server-only.ts"),
      },
    ],
  },
});
