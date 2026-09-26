"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

export function RetryMarket() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted disabled:opacity-50"
    >
      <RotateCw className={`size-3.5 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
      {pending ? "Retrying…" : "Retry"}
    </button>
  );
}
