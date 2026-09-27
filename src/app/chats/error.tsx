"use client";

export default function ChatsError({ reset }: { reset: () => void }) {
  return (
    <section aria-labelledby="chats-error">
      <h1 id="chats-error" className="text-2xl font-semibold tracking-tight">Couldn&apos;t load chats.</h1>
      <button type="button" onClick={reset} className="mt-5 min-h-11 rounded-lg border border-line px-4 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">Retry</button>
    </section>
  );
}
