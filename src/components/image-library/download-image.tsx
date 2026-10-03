"use client";

import { useState } from "react";
import { Download } from "lucide-react";

const UNAVAILABLE = "Image download unavailable. Try again.";
const messages: Record<number, string> = {
  401: "Sign in again to download your image.",
  404: "Image not found. Return to the library and try again.",
  410: "Image is no longer available.",
};

/** Do not turn a private API error response into a downloaded file. */
export async function requestImageDownload(id: string): Promise<Blob> {
  const response = await fetch(`/api/image-library/${encodeURIComponent(id)}/file?download=1`, {
    credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(messages[response.status] ?? UNAVAILABLE);
  const length = response.headers.get("content-length");
  if (response.headers.get("content-type") !== "image/png" || (length !== null && Number(length) > 10 * 1024 * 1024)) throw new Error(UNAVAILABLE);
  const blob = await response.blob();
  if (blob.size < 45 || blob.size > 10 * 1024 * 1024) throw new Error(UNAVAILABLE);
  return blob;
}

export function DownloadImage({ id, title, prominent = false }: { id: string; title: string; prominent?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true); setError(null);
    try {
      const blob = await requestImageDownload(id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${id}.png`;
      document.body.append(link); link.click(); link.remove();
      // Give the browser time to start saving, then release the temporary private bytes.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (failure) {
      setError(failure instanceof Error && Object.values(messages).includes(failure.message) ? failure.message : UNAVAILABLE);
    } finally { setBusy(false); }
  }
  return <div className="min-w-0">
    <button type="button" onClick={download} disabled={busy} aria-label={`Download ${title}`} className={`inline-flex items-center gap-1.5 rounded-lg disabled:opacity-60 outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70 ${prominent ? "min-h-11 bg-fg px-4 text-sm font-medium text-canvas hover:bg-white" : "min-h-11 px-2 text-xs hover:bg-surface-hover"}`}>
      <Download className="size-3.5 shrink-0" aria-hidden="true" />{busy ? "Downloading…" : prominent ? "Download PNG" : "Download"}
    </button>
    {error && <p role="alert" className="mt-2 max-w-xs text-xs leading-5 text-fg-muted">{error}</p>}
  </div>;
}
