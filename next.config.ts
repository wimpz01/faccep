import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve the generated app/icon.tsx at the conventional /favicon.ico path too.
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon" }];
  },
};

export default nextConfig;
