import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ConnectionCard } from "@/components/mcp/connection-card";

export const metadata: Metadata = {
  title: "Free Roblox analytics MCP",
  description: "Connect an MCP-compatible AI app to Romanum’s free, read-only public Roblox data. Public analytics are also available in the browser without installing MCP.",
  alternates: { canonical: "https://romanum.dev/connect" },
};

export default function ConnectPage() {
  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Get MCP</h1>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-muted">
          Free, read-only
        </span>
      </header>

      <p className="mb-4 text-sm text-fg-muted">Connect an MCP-compatible AI app to Romanum.</p>

      <ConnectionCard />

      <Link
        href="/connect/guide"
        className="mt-4 inline-flex items-center gap-1 rounded py-1 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted"
      >
        Setup guide
        <ArrowUpRight className="size-3.5 text-white" aria-hidden="true" />
      </Link>
    </>
  );
}
