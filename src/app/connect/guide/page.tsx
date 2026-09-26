import type { Metadata } from "next";
import Link from "next/link";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AssistantMarkdown } from "@/components/assistant/markdown";

export const metadata: Metadata = { title: "MCP setup" };

export default async function McpGuidePage() {
  // One fixed repository document; never accept a filename from a request.
  const source = await readFile(path.join(process.cwd(), "docs", "mcp.md"), "utf8");
  return (
    <article className="max-w-3xl">
      <Link href="/connect" className="text-sm text-fg-muted underline-offset-4 hover:underline">← Get MCP</Link>
      <h1 className="mt-6 mb-6 text-2xl font-semibold tracking-tight">MCP setup</h1>
      <div className="text-sm leading-7 text-fg-muted [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-4">
        <AssistantMarkdown text={source.replace(/^# [^\n]+\r?\n/, "")} />
      </div>
    </article>
  );
}
