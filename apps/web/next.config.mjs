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
  experimental: {
    // Material packages routinely exceed the 1 MB default Server Action body limit.
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
