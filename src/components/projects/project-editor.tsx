"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeft, MessageSquarePlus, RotateCcw } from "lucide-react";
import type { ProjectBrief } from "@/lib/projects/store";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const FIELD = `mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-fg-subtle disabled:opacity-60 ${FOCUS}`;
const SECONDARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm hover:bg-surface disabled:opacity-40 ${FOCUS}`;
const values = (project: ProjectBrief | null) => ({ name: project?.name ?? "", gameplay: project?.context.gameplay ?? "", audience: project?.context.audience ?? "", artDirection: project?.context.artDirection ?? "", constraints: project?.context.constraints.join("\n") ?? "", plan: project?.context.plan ?? "" });

export function ProjectEditor({ initial, embedded = false, onSaved }: { initial: ProjectBrief | null; embedded?: boolean; onSaved?: (project: ProjectBrief) => void }) {
  const router = useRouter();
  const [project, setProject] = useState(initial);
  const [fields, setFields] = useState(() => values(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(fields) !== JSON.stringify(values(project));
  // A live sidebar follows saved AI updates only while pristine. Dirty edits keep
  // their original revision, so a concurrent save still gets the existing conflict check.
  if (initial && project?.id === initial.id && initial.revision > project.revision && !dirty && !busy) {
    setProject(initial);
    setFields(values(initial));
    setSaved(false);
  }
  const change = (key: keyof typeof fields, value: string) => { setFields((before) => ({ ...before, [key]: value })); setSaved(false); };

  async function save(archived = project?.archived ?? false) {
    setBusy(true); setError(null); setConflict(false); setSaved(false);
    try {
      const context = { ...project?.context, game: fields.name, gameplay: fields.gameplay, audience: fields.audience, artDirection: fields.artDirection, constraints: fields.constraints.split("\n").map((line) => line.trim()).filter(Boolean), plan: fields.plan };
      const body = { name: fields.name, context, ...(project ? { revision: project.revision, archived } : {}) };
      const response = await fetch(project ? `/api/projects/${project.id}` : "/api/projects", { method: project ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setConflict(response.status === 409 && !!project); throw new Error(result.error ?? "Couldn't save the project."); }
      const next = result.project as ProjectBrief;
      setProject(next); setFields(values(next)); setSaved(true);
      onSaved?.(next);
      if (!project) router.replace(`/projects/${next.id}`);
      if (!embedded) router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn't save the project."); }
    finally { setBusy(false); }
  }

  async function reload() {
    if (!project) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`);
      if (!response.ok) throw new Error("Couldn't reload the project.");
      const data = await response.json();
      setProject(data.project); setFields(values(data.project)); setError(null); setConflict(false); setSaved(false);
      onSaved?.(data.project);
    } catch { setError("Couldn't reload the project."); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void save(); }
  return <div className="mx-auto max-w-3xl">
    {!embedded && <Link href="/chats" className={`mb-6 inline-flex min-h-10 items-center gap-2 rounded text-sm text-fg-muted hover:text-fg ${FOCUS}`}><ArrowLeft className="size-4 text-white" />Chats</Link>}
    {!embedded && <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0"><h1 className="break-words text-2xl font-semibold tracking-tight">{project ? "Project brief" : "New project"}</h1><p className="mt-2 text-sm text-fg-muted">Shared with this project’s chats.</p></div>
      {project && !project.archived && !dirty && <Link href={`/chats?project=${project.id}`} className={SECONDARY}><MessageSquarePlus className="size-4 text-white" />New chat</Link>}
      {project?.archived && <span className="rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted">Archived</span>}
    </header>}
    <form onSubmit={submit} className="space-y-6">
      <fieldset disabled={busy || project?.archived} className="space-y-6 disabled:opacity-80">
        <label className="block text-sm font-medium">Game name<input value={fields.name} onChange={(event) => change("name", event.target.value)} required maxLength={100} autoComplete="off" className={FIELD} /></label>
        <label className="block text-sm font-medium">Game plan<textarea value={fields.plan} onChange={event => change("plan", event.target.value)} rows={8} maxLength={12000} placeholder="Build this together in chat." className={`${FIELD} resize-y`} /></label>
        <label className="block text-sm font-medium">Core loop<textarea value={fields.gameplay} onChange={(event) => change("gameplay", event.target.value)} rows={4} maxLength={2000} placeholder="What does the player do?" className={`${FIELD} resize-y`} /></label>
        <div className="grid gap-6 sm:grid-cols-2">
          <label className="block text-sm font-medium">Audience<textarea value={fields.audience} onChange={(event) => change("audience", event.target.value)} rows={3} maxLength={500} placeholder="Who are you building for?" className={`${FIELD} resize-y`} /></label>
          <label className="block text-sm font-medium">Visual style<textarea value={fields.artDirection} onChange={(event) => change("artDirection", event.target.value)} rows={3} maxLength={1000} className={`${FIELD} resize-y`} /></label>
        </div>
        <label className="block text-sm font-medium">Constraints<textarea value={fields.constraints} onChange={(event) => change("constraints", event.target.value)} rows={3} maxLength={3611} placeholder="One per line" className={`${FIELD} resize-y`} /></label>
      </fieldset>
      {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-fg-muted"><p>{error}</p>{conflict && <button type="button" disabled={busy} onClick={reload} className={`underline underline-offset-4 ${FOCUS}`}>Reload brief</button>}</div>}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
        {!project?.archived && <button type="submit" disabled={busy || (!dirty && !!project)} className={`min-h-11 rounded-lg bg-fg px-5 text-sm font-medium text-canvas hover:bg-white disabled:opacity-40 ${FOCUS}`}>{busy ? "Saving…" : project ? "Save changes" : "Create project"}</button>}
        <span role="status" className="text-sm text-fg-muted">{saved ? "Saved" : dirty && project ? "Unsaved changes" : ""}</span>
        {project && <button type="button" disabled={busy || dirty} onClick={() => save(!project.archived)} className={`${SECONDARY} sm:ml-auto`}>
          {project.archived ? <RotateCcw className="size-4 text-white" /> : <Archive className="size-4 text-white" />}{project.archived ? "Restore project" : "Archive"}
        </button>}
      </div>
    </form>
  </div>;
}
