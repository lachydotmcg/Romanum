"use client";

import Link from "next/link";

export default function GameError({ reset }: { reset: () => void }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Couldn&apos;t load game.</h1>
      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm">
        <button onClick={reset} className="min-h-11 rounded-lg border border-line px-4 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">Retry</button>
        <Link href="/analytics" className="inline-flex min-h-11 items-center text-fg-muted hover:text-fg">Back to Analytics</Link>
      </div>
    </section>
  );
}
