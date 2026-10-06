/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kanakku/core', '@kanakku/db', '@kanakku/mcp-server'],
};

export default nextConfig;
