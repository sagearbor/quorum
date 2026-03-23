/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [],
  webpack: (config) => {
    config.resolve.extensions.push(".json");
    return config;
  },
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:9000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/:path*`,
      },
      {
        source: "/quorums/:path*",
        destination: `${apiBase}/quorums/:path*`,
      },
    ];
  },
};

export default nextConfig;
