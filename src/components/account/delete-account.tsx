"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { X } from "lucide-react";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function DeleteAccount({ accountId, username }: { accountId: string; username: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (busy || confirmation !== "DELETE") return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/account/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, confirmation }),
      });
      const result = await response.json();
      if (!response.ok || result.deleted !== true) throw new Error(result.error ?? "Deletion unavailable. Try again later.");
      // Drop all cached account data and in-memory transcripts after deleting it.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/profile?deleted=1");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Deletion unavailable. Try again later.");
      setBusy(false);
    }
  }

  return <>
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
      <h2 className="text-sm font-medium">Delete account</h2>
      <button ref={trigger} type="button" onClick={() => { setConfirmation(""); setError(""); dialog.current?.showModal(); }} className={`min-h-11 rounded-lg border border-line px-4 text-sm hover:bg-surface-hover ${FOCUS}`}>Delete account</button>
    </div>
    <dialog ref={dialog} aria-labelledby="delete-account-heading" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => trigger.current?.focus()} className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-md max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-6 text-fg backdrop:bg-black/70">
      <header className="flex items-center justify-between gap-3">
        <h2 id="delete-account-heading" className="text-lg font-semibold">Delete @{username}?</h2>
        <button type="button" aria-label="Close deletion" disabled={busy} onClick={() => dialog.current?.close()} className={`grid size-8 shrink-0 place-items-center rounded-lg hover:bg-surface-hover disabled:opacity-40 ${FOCUS}`}><X className="size-5" aria-hidden="true" /></button>
      </header>
      <p className="mt-4 text-sm leading-relaxed text-fg-muted">Your profile, chats, projects, images and linked game data will be permanently removed. Unused credits won’t transfer if you return.</p>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">Credit and security records remain. <Link href="/privacy#retention" target="_blank" className="text-fg underline underline-offset-4">Details</Link></p>
      <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void remove(); }}>
        <label htmlFor="delete-confirmation" className="block text-sm">Type DELETE to confirm</label>
        <input id="delete-confirmation" autoFocus autoComplete="off" spellCheck={false} value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className={`mt-2 min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-sm disabled:opacity-50 ${FOCUS}`} />
        {error && <p role="alert" className="mt-3 text-sm text-fg-muted">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()} className={`min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover disabled:opacity-50 ${FOCUS}`}>Cancel</button>
          <button type="submit" disabled={busy || confirmation !== "DELETE"} className={`min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white disabled:opacity-40 ${FOCUS}`}>{busy ? "Deleting…" : "Delete account"}</button>
        </div>
      </form>
    </dialog>
  </>;
}
