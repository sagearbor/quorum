/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [],
  // Lint runs as a CI hard gate; don't re-run it during the production
  // build (Vercel/Railway).  Keeps deploys unblocked when CI is also green.
  eslint: {
    ignoreDuringBuilds: true,
  },
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
