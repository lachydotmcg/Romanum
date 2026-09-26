import Link from "next/link";
import { ArrowUpRight, Download } from "lucide-react";
import { SKILL_CATALOG } from "@/lib/skill-catalog";
import { SkillsMark } from "@/components/skills-mark";

export const metadata = { title: "Skills" };

export default function SkillsPage() {
  return (
    <>
      <header className="mb-8 flex items-center justify-between gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
        <a href="https://github.com/lachydotmcg/Romanum" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded py-1 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">GitHub <ArrowUpRight className="size-3.5 text-white" aria-hidden="true" /></a>
      </header>
      <div className="space-y-4">
        {SKILL_CATALOG.map((skill) => <article key={skill.id} className="flex flex-wrap items-center justify-between gap-5 rounded-xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <SkillsMark className="size-7 shrink-0 text-fg-muted" aria-hidden="true" />
            <div><h2 className="text-base font-semibold">{skill.name}</h2><p className="mt-1 text-sm text-fg-muted">{skill.description}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/skills/${skill.id}`} aria-label={`${skill.name} guide`} className="rounded-lg px-3 py-2 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">Guide</Link>
            <a href={`/api/skills/${skill.id}`} aria-label={`Download ${skill.name}`} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted"><Download className="size-3.5 text-white" aria-hidden="true" />Download</a>
            <Link href={`/analytics?starter=${skill.id}`} aria-label={`Use ${skill.name}`} className="rounded-lg bg-fg px-3 py-2 text-xs font-medium text-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg">Use</Link>
          </div>
        </article>)}
      </div>
    </>
  );
}
