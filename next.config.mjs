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
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

import analyzer from '@next/bundle-analyzer';
const withBundleAnalyzer = analyzer({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer(nextConfig);

// import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
// initOpenNextCloudflareForDev();