import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Public deploy address only: pin background dispatch to this build, including previews.
  // DEPLOY_URL itself is build-only on Netlify; never inline provider or database secrets here.
  env: { ROMANUM_CHAT_RUN_ORIGIN: process.env.DEPLOY_URL ?? "" },
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
  // Keep agent instructions local: stop `next dev` generating AGENTS.md or CLAUDE.md.
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
