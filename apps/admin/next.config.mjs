/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@prisma/client",
    ".prisma/client",
    // pg (pgpass) は Node 組み込みモジュール (path/fs) に依存するため
    // サーバーバンドルから外部化する (instrumentation → prisma.ts 経由でロードされる)。
    "pg",
    "@prisma/adapter-pg",
  ],
  webpack: (config) => {
    // instrumentation hook のバンドルには serverExternalPackages が適用されないため、
    // pg 系を明示的に外部化する (ランタイムの node_modules から解決される)。
    config.externals = [
      ...(Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : []),
      { pg: "commonjs pg", pgpass: "commonjs pgpass" },
    ];
    return config;
  },
};
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
