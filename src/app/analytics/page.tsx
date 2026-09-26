import type { Metadata } from "next";
import { ArrowUp } from "lucide-react";

export const metadata: Metadata = {
  title: "Analytics",
};

export default function AnalyticsPage() {
  return (
    <>
      {/* AI assistance area. Not connected yet: the input and send button stay disabled. */}
      <section aria-label="AI assistant">
        <div className="flex h-12 items-center gap-3 rounded-xl border border-line bg-surface pr-2 pl-4">
          <label htmlFor="ai-prompt" className="sr-only">
            Ask the AI assistant
          </label>
          <input
            id="ai-prompt"
            type="text"
            disabled
            placeholder="Ask about your analytics"
            aria-describedby="ai-status"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none disabled:cursor-not-allowed"
          />
          <span
            id="ai-status"
            className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-xs text-fg-muted"
          >
            Not connected
          </span>
          <button
            type="button"
            disabled
            aria-label="Send"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover text-fg-subtle disabled:cursor-not-allowed"
          >
            <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section aria-labelledby="analytics-heading" className="mt-10">
        <h1 id="analytics-heading" className="text-xl font-semibold tracking-tight text-fg">
          Analytics
        </h1>
        <div className="mt-4 grid min-h-88 place-items-center rounded-xl border border-line px-6 py-12 text-center">
          <div>
            <p className="text-sm font-medium text-fg">No data connected</p>
            <p className="mt-1 text-sm text-fg-muted">
              Analytics will appear here once a game&apos;s data is connected.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
