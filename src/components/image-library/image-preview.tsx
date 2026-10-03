"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

export function ImagePreview({ id, title, thumbnail = true }: { id: string; title: string; thumbnail?: boolean }) {
  const src = `/api/image-library/${encodeURIComponent(id)}/file${thumbnail ? "?variant=thumbnail" : ""}`;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return failedSource === src ? <div role="status" className="flex min-h-48 flex-col items-center justify-center gap-2 text-sm text-fg-muted">
    <ImageOff className="size-6" aria-hidden="true" />Image unavailable
  </div> : (
    // The private endpoint needs the browser's session cookie; do not use a shared image optimizer.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={title}
      loading={thumbnail ? "lazy" : "eager"} decoding="async" onError={() => setFailedSource(src)}
      className={`mx-auto w-full object-contain ${thumbnail ? "h-full max-h-64" : "h-auto max-h-[65dvh]"}`} />
  );
}
