/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow importing seed JSON from outside apps/web/
  transpilePackages: [],
  webpack: (config) => {
    // Ensure JSON files outside the app root can be resolved
    config.resolve.extensions.push(".json");
    return config;
  },
};

export default nextConfig;
