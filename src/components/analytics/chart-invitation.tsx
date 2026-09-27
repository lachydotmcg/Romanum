"use client";

import Link from "next/link";
import { ChartNoAxesCombined } from "lucide-react";
import { prefillAssistant } from "@/components/assistant/prefill";

export function ChartInvitation({ connected }: { connected: boolean }) {
  return <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <button type="button" disabled={!connected} onClick={() => prefillAssistant({ prompt: "Create a bar chart of the 10 games with the most players in Roblox's Top Playing Now chart." })}
      className="inline-flex min-h-8 items-center gap-2 text-fg-muted hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white">
      <ChartNoAxesCombined className="size-4 text-white" aria-hidden="true" /> Ask AI to create a chart
    </button>
    <Link href="/analytics?view=charts" prefetch={false} scroll={false} className="text-fg-muted hover:text-white">Build your own →</Link>
  </div>;
}
