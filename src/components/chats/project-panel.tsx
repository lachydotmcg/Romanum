"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PanelRight, X } from "lucide-react";
import type { ProjectBrief } from "@/lib/projects/store";
import type { AssetPlanSummary } from "@/lib/projects/plans";
import type { ReferenceSummary } from "@/lib/projects/references";
import type { ChatSummary } from "@/lib/chats/store";
import { ProjectEditor } from "@/components/projects/project-editor";
import { ReferenceLibrary } from "@/components/projects/reference-library";
import { PlanCard } from "@/components/projects/plan-card";

type Tab = "brief" | "roadmap" | "references" | "plans";
type Workspace = { project: ProjectBrief; plans: AssetPlanSummary[]; references: ReferenceSummary[]; chats: ChatSummary[] };
const TABS: { id: Tab; label: string }[] = [{ id: "brief", label: "Context" }, { id: "roadmap", label: "Roadmap" }, { id: "references", label: "References" }, { id: "plans", label: "Assets" }];
const FOCUS = "focus-visible:outline-2 focus-visible:outline-fg/70 outline-offset-2";

export function ProjectPanel({ project, onSaved, initialTab }: { project: ProjectBrief; onSaved: (project: ProjectBrief) => void; initialTab?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>(TABS.some(item => item.id === initialTab) ? initialTab as Tab : "brief");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!initialTab) return;
    dialog.current?.showModal();
    const controller = new AbortController();
    fetch(`/api/projects/${project.id}/workspace`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Context unavailable. Try again.");
      const data: Workspace = await response.json();
      if (!controller.signal.aborted) { setWorkspace(data); onSaved(data.project); }
    }).catch(() => { if (!controller.signal.aborted) setError("Context unavailable. Try again."); });
    return () => controller.abort();
  }, [initialTab, project.id, onSaved]);

  async function load() {
    setError(""); setLoading(true);
    try {
      const response = await fetch(`/api/projects/${project.id}/workspace`);
      if (!response.ok) throw new Error("Context unavailable. Try again.");
      const data: Workspace = await response.json(); setWorkspace(data); onSaved(data.project);
    } catch { setError("Context unavailable. Try again."); }
    finally { setLoading(false); }
  }
  async function check(id: string, done: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: project.name, revision: project.revision, archived: project.archived, context: { ...project.context, todos: project.context.todos?.map(todo => todo.id === id ? { ...todo, done } : todo) } }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Couldn't save this task.");
      onSaved(data.project);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save this task."); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={trigger} type="button" onClick={() => { dialog.current?.showModal(); void load(); }} className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-line px-3 text-xs hover:bg-surface ${FOCUS}`}><PanelRight className="size-4" />Context</button>
    <dialog ref={dialog} aria-labelledby="project-context-heading" onClose={() => trigger.current?.focus()} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-xl max-w-full overflow-y-auto border-l border-line bg-canvas p-5 text-fg backdrop:bg-black/60 sm:p-7">
      <header className="flex items-center justify-between gap-3"><div className="min-w-0"><h2 id="project-context-heading" className="truncate text-lg font-semibold">{project.name}</h2>{project.archived && <p className="text-xs text-fg-muted">Archived</p>}</div><button type="button" onClick={() => dialog.current?.close()} aria-label="Close project context" className={`grid size-10 shrink-0 place-items-center rounded-lg hover:bg-surface ${FOCUS}`}><X className="size-5" /></button></header>
      <nav aria-label="Project context" className="mt-5 mb-6 flex gap-1 overflow-x-auto border-b border-line">{TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)} className={`min-h-11 shrink-0 border-b-2 px-2.5 text-sm ${FOCUS} ${tab === item.id ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>{item.label}</button>)}</nav>
      {error && <p role="alert" className="mb-4 text-sm text-fg-muted">{error} <button type="button" onClick={load} className="underline underline-offset-4">Reload</button></p>}
      {tab === "brief" && (loading ? <p className="text-sm text-fg-muted">Loading…</p> : <ProjectEditor key={project.id} initial={project} embedded onSaved={onSaved} />)}
      {tab === "roadmap" && <div className="space-y-8">
        {project.context.roadmap?.length ? <ol className="space-y-5">{project.context.roadmap.map((phase, index) => <li key={index} className="flex gap-3"><span className="text-sm text-fg-subtle tabular-nums">{index + 1}.</span><div className="min-w-0"><h3 className="break-words text-sm font-medium">{phase.title}</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-muted">{phase.detail}</p></div></li>)}</ol> : <p className="text-sm text-fg-muted">Plan the next steps in chat.</p>}
        {!!project.context.todos?.length && <section><h3 className="mb-3 text-sm font-medium">To-dos</h3><ul className="space-y-1">{project.context.todos.map(todo => <li key={todo.id}><label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-3 text-sm hover:bg-surface ${todo.done ? "text-fg-subtle" : ""}`}><input type="checkbox" checked={todo.done} disabled={busy || project.archived} onChange={event => void check(todo.id, event.target.checked)} className={`mt-0.5 size-4 shrink-0 accent-white ${FOCUS}`} /><span className={`min-w-0 break-words ${todo.done ? "line-through" : ""}`}>{todo.text}</span></label></li>)}</ul></section>}
      </div>}
      {tab === "references" && (workspace ? <ReferenceLibrary key={project.id} projectId={project.id} archived={project.archived} initial={workspace.references} /> : <p className="text-sm text-fg-muted">{loading ? "Loading…" : "References unavailable."}</p>)}
      {tab === "plans" && (workspace?.plans.length ? <div className="space-y-3">{workspace.plans.map(plan => <PlanCard key={plan.id} plan={plan} />)}</div> : <p className="text-sm text-fg-muted">{loading ? "Loading…" : "Plan a thumbnail or UI in chat."}</p>)}
      {!!workspace?.chats.length && <details className="mt-8 border-t border-line pt-5 text-sm"><summary className={`cursor-pointer text-fg-muted ${FOCUS}`}>Project chats</summary><ul className="mt-3 space-y-1">{workspace.chats.map(chat => <li key={chat.id}><Link href={`/chats/${chat.id}`} onClick={() => dialog.current?.close()} className={`block truncate rounded-lg px-2 py-3 hover:bg-surface ${FOCUS}`}>{chat.title}</Link></li>)}</ul></details>}
    </dialog>
  </>;
}
