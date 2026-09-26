import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev-only Next.js badge clear of the sidebar's profile area.
  devIndicators: { position: "bottom-right" },

  // Analytics is the initial destination.
  async redirects() {
    return [{ source: "/", destination: "/analytics", permanent: false }];
  },
};

export default nextConfig;
