"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Plus } from "lucide-react";
import type { ProjectSummary } from "@/lib/projects/store";
import { Select } from "../select";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
export function ProjectList({ projects, archived }: { projects: ProjectSummary[]; archived: boolean }) {
  const router = useRouter();
  return <div className="mx-auto max-w-4xl">
    <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <Link href="/projects/new" className={`inline-flex min-h-11 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white ${FOCUS}`}><Plus className="size-4" />New project</Link>
    </header>
    <div className="mb-4 flex justify-end"><Select label="Project status" value={archived ? "archived" : "active"} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} onChange={(value) => router.push(value === "archived" ? "/projects?archived=true" : "/projects")} /></div>
    {projects.length ? <ul className="divide-y divide-line border-y border-line">
      {projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}`} className={`group flex min-h-24 items-center justify-between gap-4 rounded-lg px-3 py-5 hover:bg-surface ${FOCUS}`}>
        <div className="min-w-0"><h2 className="truncate text-base font-medium">{project.name}</h2>{project.description && <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{project.description}</p>}</div>
        <ArrowUpRight className="size-4 shrink-0 text-white" aria-hidden="true" />
      </Link></li>)}
    </ul> : <div className="rounded-xl border border-line px-5 py-14 text-center"><p className="text-sm text-fg-muted">{archived ? "No archived projects." : "Your next game starts here."}</p>{!archived && <Link href="/projects/new" className={`mt-4 inline-block rounded text-sm underline underline-offset-4 ${FOCUS}`}>Create a project</Link>}</div>}
  </div>;
}
