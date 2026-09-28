"use client";

import { useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { Plus, Trash2, X } from "lucide-react";
import { Select } from "@/components/select";
import type { ReferenceSummary } from "@/lib/projects/references";
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from "@/lib/chats/limits";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const FIELD = `mt-2 min-h-11 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm ${FOCUS}`;

export function ReferenceLibrary({ projectId, archived, initial }: { projectId: string; archived: boolean; initial: ReferenceSummary[] }) {
  const [references, setReferences] = useState(initial);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [rights, setRights] = useState("");
  const [rightsNote, setRightsNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<ReferenceSummary | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const endpoint = `/api/projects/${projectId}/references`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !file || !rights) return;
    if (file.size > MAX_ATTACHMENT_BYTES || !IMAGE_TYPES.includes(file.type as typeof IMAGE_TYPES[number])) { setError("Choose a PNG, JPEG or WebP, up to 5 MB."); return; }
    setBusy(true); setError("");
    try {
      const body = new FormData(); body.set("file", file);
      body.set("metadata", JSON.stringify({ label, rights, rightsNote: rights === "owned" ? "I own this image." : rightsNote }));
      const response = await fetch(endpoint, { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Couldn't save the reference.");
      setReferences(current => [result.reference, ...current]);
      setOpen(false); setFile(null); setLabel(""); setRights(""); setRightsNote("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save the reference."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!removing || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}/${removing.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Couldn't remove the reference.");
      setReferences(current => current.filter(item => item.id !== removing.id));
      dialog.current?.close(); setRemoving(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't remove the reference."); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="project-references" className="mx-auto mt-10 max-w-3xl border-t border-line pt-6">
    <header className="flex items-center justify-between gap-3">
      <div><h2 id="project-references" className="text-base font-medium">References</h2><p className="mt-1 text-xs text-fg-muted">Private images to attach in project chats.</p></div>
      {!archived && <button type="button" disabled={busy} onClick={() => { setOpen(!open); setError(""); }} className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-line px-3 text-sm whitespace-nowrap hover:bg-surface disabled:opacity-40 ${FOCUS}`}><Plus className="size-4" aria-hidden="true" />Add image</button>}
    </header>
    {open && !archived && <form onSubmit={save} className="mt-5 rounded-xl border border-line bg-surface p-4">
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm">Image<input ref={fileInput} type="file" accept={IMAGE_TYPES.join(",")} required onChange={event => { const next = event.target.files?.[0] ?? null; setFile(next); setLabel(next?.name.replace(/\.[^.]+$/, "").slice(0, 100) ?? ""); }} className="mt-2 block w-full min-w-0 text-xs text-fg-muted file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-line file:bg-canvas file:px-3 file:text-sm file:text-fg" /></label>
        <label className="block text-sm">Name<input value={label} onChange={event => setLabel(event.target.value)} required maxLength={100} className={FIELD} /></label>
        <div><span className="mb-2 block text-sm">Permission to use</span><Select label="Permission to use" value={rights} onChange={setRights} disabled={busy} options={[{ value: "", label: "Choose permission", disabled: true }, { value: "owned", label: "I own this image" }, { value: "licensed", label: "I have permission" }]} className="w-full" /></div>
        {rights === "licensed" && <label className="block text-sm">Source or permission details<input value={rightsNote} onChange={event => setRightsNote(event.target.value)} required maxLength={500} className={FIELD} /></label>}
      </fieldset>
      <div className="mt-5 flex items-center gap-3"><button type="submit" disabled={busy || !file || !label.trim() || !rights || (rights === "licensed" && !rightsNote.trim())} className={`min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas disabled:opacity-40 ${FOCUS}`}>{busy ? "Saving…" : "Save reference"}</button><button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); }} className={`min-h-11 rounded-lg px-3 text-sm text-fg-muted hover:text-fg ${FOCUS}`}>Cancel</button></div>
    </form>}
    {error && !removing && <p role="alert" className="mt-3 text-sm text-fg-muted">{error}</p>}
    {references.length === 0 ? <p className="mt-5 text-sm text-fg-muted">No references yet.</p> : <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
      {references.map(reference => <li key={reference.id} className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
        <a href={`${endpoint}/${reference.id}`} target="_blank" rel="noopener noreferrer" className={`block ${FOCUS}`} aria-label={`View ${reference.label}`}><Image src={`${endpoint}/${reference.id}`} alt={reference.label} width={reference.width} height={reference.height} unoptimized className="aspect-[4/3] w-full bg-canvas object-contain" /></a>
        <div className="flex items-center gap-1 py-2 pr-1 pl-3"><p className="min-w-0 flex-1 truncate text-sm" title={reference.label}>{reference.label}</p><button type="button" aria-label={`Remove ${reference.label}`} disabled={busy} onClick={() => { setRemoving(reference); setError(""); dialog.current?.showModal(); }} className={`grid size-10 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-surface-hover hover:text-fg ${FOCUS}`}><Trash2 className="size-4" aria-hidden="true" /></button></div>
      </li>)}
    </ul>}
    <dialog ref={dialog} aria-labelledby="remove-reference-title" onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => { setRemoving(null); setError(""); }} className="fixed inset-0 m-auto w-md max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-surface p-6 text-fg backdrop:bg-black/70">
      <header className="flex items-center justify-between gap-3"><h2 id="remove-reference-title" className="text-lg font-semibold">Remove reference?</h2><button type="button" disabled={busy} aria-label="Close removal" onClick={() => dialog.current?.close()} className={`grid size-8 place-items-center rounded-lg hover:bg-surface-hover ${FOCUS}`}><X className="size-4" /></button></header>
      <p className="mt-4 break-words text-sm text-fg-muted">{removing?.label} will be deleted from this library. Copies already attached to chats will stay in those chats.</p>
      {error && removing && <p role="alert" className="mt-3 text-sm text-fg-muted">{error}</p>}
      <div className="mt-5 flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => dialog.current?.close()} className={`min-h-11 rounded-lg px-3 text-sm ${FOCUS}`}>Cancel</button><button type="button" disabled={busy} onClick={remove} className={`min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas disabled:opacity-40 ${FOCUS}`}>{busy ? "Removing…" : "Remove"}</button></div>
    </dialog>
  </section>;
}
