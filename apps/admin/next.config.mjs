/** @type {import('next').NextConfig} */
const nextConfig = {
  // /api (better-auth) は middleware の matcher から除外されているため、
  // ページ応答に付与される HSTS と Referrer-Policy をここで補う。
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
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
