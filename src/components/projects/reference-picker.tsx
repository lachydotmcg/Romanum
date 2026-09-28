"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { FolderOpen, X } from "lucide-react";
import type { ReferenceSummary } from "@/lib/projects/references";
import { MAX_ATTACHMENT_BYTES } from "@/lib/chats/limits";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

/** Only an explicit selection copies an owned reference into this message. */
export function ReferencePicker({ projectId, disabled, onPick, onPendingChange }: { projectId: string; disabled: boolean; onPick: (file: File) => void; onPendingChange: (pending: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [references, setReferences] = useState<ReferenceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const endpoint = `/api/projects/${projectId}/references`;
  useEffect(() => () => request.current?.abort(), []);

  async function show() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setError(""); setReferences([]); setPicking(null); onPendingChange(false); setLoading(true); dialog.current?.showModal();
    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "References unavailable.");
      if (!controller.signal.aborted) setReferences(data.references);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "References unavailable."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  async function pick(reference: ReferenceSummary) {
    if (disabled || picking) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPicking(reference.id); setError(""); onPendingChange(true);
    try {
      const response = await fetch(`${endpoint}/${reference.id}`, { signal: controller.signal });
      if (!response.ok) throw new Error("This reference is no longer available.");
      const blob = await response.blob();
      if (blob.size > MAX_ATTACHMENT_BYTES || blob.type !== "image/png") throw new Error("Couldn't attach this image.");
      if (!controller.signal.aborted) {
        const name = reference.label.replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 100) || "Reference";
        onPick(new File([blob], `${name}.png`, { type: "image/png" }));
        dialog.current?.close();
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn't attach this image."); }
    finally { if (request.current === controller) { setPicking(null); onPendingChange(false); } }
  }
  function close() { request.current?.abort(); dialog.current?.close(); }
  return <>
    <button type="button" onClick={show} disabled={disabled} aria-label="Project references" title="Project references" className={`grid size-8 place-items-center rounded-full text-white hover:bg-surface-hover disabled:opacity-40 ${FOCUS}`}><FolderOpen className="size-4" aria-hidden="true" /></button>
    <dialog ref={dialog} aria-labelledby="pick-reference-title" onCancel={() => request.current?.abort()} className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-xl max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-fg backdrop:bg-black/70">
      <header className="flex items-center justify-between gap-3"><h2 id="pick-reference-title" className="text-lg font-semibold">Project references</h2><button type="button" aria-label="Close references" onClick={close} className={`grid size-9 place-items-center rounded-lg hover:bg-surface-hover ${FOCUS}`}><X className="size-4" /></button></header>
      {loading ? <p role="status" className="my-6 text-sm text-fg-muted">Loading…</p> : references.length === 0 && !error ? <p className="my-6 text-sm text-fg-muted">No references yet.</p> : <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">{references.map(reference => <li key={reference.id} className="min-w-0"><button type="button" disabled={!!picking || disabled} onClick={() => void pick(reference)} className={`w-full overflow-hidden rounded-xl border border-line bg-canvas text-left hover:border-line-strong disabled:opacity-50 ${FOCUS}`} aria-label={`Attach ${reference.label}`}><Image src={`${endpoint}/${reference.id}`} alt="" width={reference.width} height={reference.height} unoptimized className="aspect-[4/3] w-full object-contain" /><span className="block truncate px-3 py-2 text-sm">{picking === reference.id ? "Attaching…" : reference.label}</span></button></li>)}</ul>}
      {error && <p role="alert" className="mt-4 text-sm text-fg-muted">{error}</p>}
      <Link href={`/projects/${projectId}#project-references`} className={`mt-4 inline-flex min-h-11 items-center rounded-sm text-sm text-fg-muted hover:text-fg ${FOCUS}`}>Manage references</Link>
    </dialog>
  </>;
}
