"use client";
export default function ProjectsError({ reset }: { reset: () => void }) {
  return <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center gap-4 text-center"><p className="text-sm text-fg-muted">Projects unavailable. Try again.</p><button onClick={reset} className="min-h-11 rounded-lg border border-line px-4 text-sm outline-offset-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-fg/70">Retry</button></div>;
}
