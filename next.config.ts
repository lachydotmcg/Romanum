import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local database files and credentials must never enter a production deployment bundle.
  outputFileTracingExcludes: { "/*": ["./.local/**"] },
  outputFileTracingIncludes: {
    "/api/assistant": ["./skills/**/SKILL.md"],
    "/mcp": ["./skills/**/SKILL.md"],
    "/connect/guide": ["./docs/mcp.md"],
    "/api/skills/*": ["./skills/**/SKILL.md"],
    "/skills/*": ["./skills/**/SKILL.md"],
  },
  // Keep the dev-only Next.js badge clear of the sidebar's profile area.
  devIndicators: { position: "bottom-right" },

  // Analytics is the initial destination. Keep Skills hidden until it is reintroduced.
  async redirects() {
    return [
      { source: "/", destination: "/analytics", permanent: false },
      { source: "/skills/:path*", destination: "/analytics", permanent: false },
    ];
  },
};

export default nextConfig;
