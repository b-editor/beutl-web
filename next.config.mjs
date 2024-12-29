/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'beutl.beditor.net',
        port: '',
        pathname: '/api/**',
      },
      {
        protocol: 'https',
        hostname: 'beutl-dev.94ea453734259af6089d634954e014ab.r2.cloudflarestorage.com',
        port: ''
      },
    ],
  },
  experimental: {
    instrumentationHook: true,
  },
  output: "standalone",
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: 'http://localhost:5278/api/v1/:path*'
      },
      {
        source: '/api/v2/:path*',
        destination: 'http://localhost:5278/api/v2/:path*'
      }
    ]
  }
};

export default nextConfig;
