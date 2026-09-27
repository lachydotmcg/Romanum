import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both loopback addresses are used for local OAuth and Turnstile checks.
  allowedDevOrigins: ["127.0.0.1"],
  // Turbopack's persistent build cache can serialize server environment values.
  // Avoid writing those secrets to CI cache artifacts; keep secret scanning enabled.
  experimental: { turbopackFileSystemCacheForBuild: false },
  // Local database files and credentials must never enter a production deployment bundle.
  outputFileTracingExcludes: { "/*": ["./.local/**"] },
  outputFileTracingIncludes: {
    "/*": ["./src/lib/history/certs/aws-rds-global.pem"],
    "/api/assistant": ["./skills/**/SKILL.md"],
    "/mcp": ["./skills/**/SKILL.md"],
    "/connect/guide": ["./docs/mcp.md"],
    "/api/skills/*": ["./skills/**/SKILL.md"],
    "/skills/*": ["./skills/**/SKILL.md"],
  },
  // Keep the dev-only Next.js badge clear of the sidebar's profile area.
  devIndicators: { position: "bottom-right" },
  // AGENTS.md is deliberately empty: stop `next dev` writing its agent rules into it or creating CLAUDE.md.
  agentRules: false,

  // Analytics is the initial destination. Keep Skills hidden until it is reintroduced.
  async redirects() {
    return [
      { source: "/", destination: "/analytics", permanent: false },
      { source: "/skills/:path*", destination: "/analytics", permanent: false },
    ];
  },
};

export default nextConfig;
