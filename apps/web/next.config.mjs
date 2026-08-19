import { dashboardRedirects } from "./next.redirects.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return dashboardRedirects();
  },
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
  experimental: {
    // Material packages routinely exceed the 1 MB default Server Action body limit.
    serverActions: {
      bodySizeLimit: "100mb",
    },
    // A request that goes through the middleware has its body buffered, and
    // whatever runs past this limit is dropped. The 10 MB default cut a larger
    // upload down to a body its own handler could no longer parse.
    middlewareClientMaxBodySize: "100mb",
  },
};

import analyzer from '@next/bundle-analyzer';
const withBundleAnalyzer = analyzer({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer(nextConfig);

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
