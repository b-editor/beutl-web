import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web/src"),
      "@beutl/api": path.resolve(__dirname, "packages/api/src/index.ts"),
      "@beutl/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@beutl/db": path.resolve(__dirname, "packages/db/src/index.ts"),
      "@beutl/i18n": path.resolve(__dirname, "packages/i18n/src/index.ts"),
      // server-only は Next.js 専用パッケージ。契約テストは node 環境で実行するため
      // 空モジュールに解決する (抽出パッケージは server-only を除去済み)。
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
