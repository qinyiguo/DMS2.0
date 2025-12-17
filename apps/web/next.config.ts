import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ops/db"]
};

export default nextConfig;
