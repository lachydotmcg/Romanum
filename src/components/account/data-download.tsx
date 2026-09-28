"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function DataDownload() {
  const [includeImages, setIncludeImages] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(""); setStatus("Preparing download…");
    try {
      const { buildAccountArchive } = await import("@/lib/accounts/export-archive");
      const blob = await buildAccountArchive({ includeImages, signal: controller.signal, progress: setStatus });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `romanum-data-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus("Download ready.");
    } catch (failure) {
      if (controller.signal.aborted) setStatus("Download cancelled.");
      else { setError(failure instanceof Error ? failure.message : "Download failed. Try again."); setStatus(""); }
    } finally { active.current = null; setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line p-5 sm:p-6">
      <h2 className="font-medium">Download your data</h2>
      <p className="mt-1 text-sm text-fg-muted">Chats, projects, game analytics and credit history.</p>
      <label className="mt-5 flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
        <input type="checkbox" checked={includeImages} disabled={busy} onChange={(event) => setIncludeImages(event.target.checked)} className={`size-4 accent-white ${FOCUS}`} />
        Include images
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={download} className={`flex min-h-11 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-60 ${FOCUS}`}>
          {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
          {busy ? "Preparing…" : "Download ZIP"}
        </button>
        {busy && <button type="button" onClick={() => active.current?.abort()} className={`min-h-11 rounded-lg px-3 text-sm hover:bg-surface-hover ${FOCUS}`}>Cancel</button>}
      </div>
      <p role="status" aria-live="polite" className="mt-3 text-xs text-fg-muted empty:hidden">{status}</p>
      {error && <p role="alert" className="mt-3 text-sm text-fg-muted">{error}</p>}
    </div>
  );
}
