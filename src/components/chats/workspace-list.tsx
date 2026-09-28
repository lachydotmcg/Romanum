import Link from "next/link";
import { ArrowUpRight, Folder } from "lucide-react";
import type { ProjectSummary } from "@/lib/projects/store";

export function WorkspaceList({ projects, archived }: { projects: ProjectSummary[]; archived: boolean }) {
  return <section className="mt-9" aria-labelledby="chat-projects">
    <header className="mb-2 flex items-center justify-between px-3 text-xs text-fg-muted"><h2 id="chat-projects">{archived ? "Archived projects" : "Projects"}</h2><Link href={archived ? "/chats" : "/chats?archived=true"} className="rounded py-2 hover:text-fg focus-visible:outline-2">{archived ? "Active" : "Archived"}</Link></header>
    {projects.length ? <ul>{projects.map(project => <li key={project.id}><Link href={`/projects/${project.id}`} className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-surface focus-visible:outline-2"><Folder className="size-4 shrink-0 text-fg-muted" /><span className="min-w-0 flex-1 truncate">{project.name}</span><ArrowUpRight className="size-3.5 text-fg-subtle" /></Link></li>)}</ul> : archived ? <p className="px-3 py-3 text-sm text-fg-muted">No archived projects.</p> : null}
  </section>;
}
