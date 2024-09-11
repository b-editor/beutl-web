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
    ],
  },
};

export default nextConfig;
