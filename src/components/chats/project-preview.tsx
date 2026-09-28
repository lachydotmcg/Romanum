"use client";

import type { CSSProperties, RefObject } from "react";
import { ArrowUpRight, PanelRight } from "lucide-react";
import type { ProjectBrief } from "@/lib/projects/store";
import styles from "./project-context.module.css";

export type ContextTab = "brief" | "roadmap" | "references" | "plans";

/** Actual saved text assembles in three strips; extra visual copies stay out of the accessibility tree. */
function AssembledText({ text, animate }: { text: string; animate: boolean }) {
  return <span className={animate ? styles.fragments : styles.summary}>
    <span className={styles.summary}>{text}</span>
    {animate && <><span aria-hidden="true" className={styles.summary}>{text}</span><span aria-hidden="true" className={styles.summary}>{text}</span></>}
  </span>;
}

function PlanMark({ animate }: { animate: boolean }) {
  return <svg viewBox="0 0 32 36" fill="none" aria-hidden="true" className={`h-9 w-8 shrink-0 ${animate ? styles.markAssembling : ""}`}>
    <path d="M12 3H27V32H5V15" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 3H9V7H5Z" fill="currentColor" />
    <path d="M3 10H7V14H3Z" fill="currentColor" opacity=".6" />
    <path d="M11 11H21M11 17H21M11 23H18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

export function ProjectPreview({ project, animationVersion, expanded, controls, trigger, onOpen }: {
  project: ProjectBrief;
  animationVersion: number;
  expanded: boolean;
  controls: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpen: (tab: ContextTab) => void;
}) {
  const { context } = project;
  const animate = animationVersion > 0;
  const tasks = context.todos ?? [];
  const nextTask = tasks.find(task => !task.done);
  const sections: { label: string; text: string; tab: ContextTab }[] = [];
  if (context.plan) sections.push({ label: "Game design", text: context.plan, tab: "brief" });
  if (context.gameplay) sections.push({ label: "Core loop", text: context.gameplay, tab: "brief" });
  if (context.audience) sections.push({ label: "Audience", text: context.audience, tab: "brief" });
  if (context.roadmap?.length) sections.push({ label: "Roadmap", text: context.roadmap.map(phase => phase.title).join(" · "), tab: "roadmap" });
  if (tasks.length) sections.push({ label: `To-dos · ${tasks.filter(task => task.done).length}/${tasks.length}`, text: nextTask?.text ?? "All tasks complete", tab: "roadmap" });

  return <div className={`${styles.preview} ${animate ? styles.previewAssembling : ""}`}>
    <button ref={trigger} type="button" onClick={() => onOpen("brief")} aria-label={`Open project context: ${project.name}`} aria-expanded={expanded} aria-controls={controls} className={styles.previewHeading}>
      <PlanMark key={animationVersion} animate={animate} />
      <span className="min-w-0 flex-1 text-left"><span className="block text-[11px] text-fg-muted">{project.archived ? "Archived project" : "Project context"}</span><span className="mt-0.5 block truncate text-sm font-medium">{project.name}</span></span>
      <PanelRight className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
    </button>
    <div className={styles.previewSections}>
      {sections.map((section, index) => <button key={`${section.label}:${section.text}`} type="button" onClick={() => onOpen(section.tab)} aria-label={`Open ${section.label}`} aria-controls={controls} className={styles.previewSection} style={{ "--assemble-delay": `${index * 65}ms` } as CSSProperties}>
        <span className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-fg-muted"><span>{section.label}</span><ArrowUpRight className="size-3.5 opacity-0 group-hover:opacity-100" aria-hidden="true" /></span>
        <AssembledText text={section.text} animate={animate} />
      </button>)}
      {!sections.length && <p className="px-4 pt-1 pb-4 text-xs text-fg-muted">Build your plan in chat.</p>}
    </div>
    <span aria-live="polite" className="sr-only">{animate ? `Project context saved. Revision ${project.revision}.` : ""}</span>
  </div>;
}
