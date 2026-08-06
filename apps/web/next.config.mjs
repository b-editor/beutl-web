/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "beutl.beditor.net",
        port: "",
        pathname: "/api/**",
      },
      {
        protocol: "https",
        hostname:
          "beutl-dev.94ea453734259af6089d634954e014ab.r2.cloudflarestorage.com",
        port: "",
      },
    ],
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

import analyzer from '@next/bundle-analyzer';
const withBundleAnalyzer = analyzer({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer(nextConfig);

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
