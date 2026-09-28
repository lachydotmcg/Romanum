import Link from "next/link";
import { ArrowLeft, ChevronRight, Download, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { AssetPlan } from "@/lib/projects/plans";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
function Disclosure({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return <details className="group/disclosure"><summary className={`flex cursor-pointer list-none items-center gap-2 rounded py-2 text-sm text-fg-muted hover:text-fg ${FOCUS} [&::-webkit-details-marker]:hidden`}>
    <ChevronRight className="size-3.5 shrink-0 text-white transition-transform group-open/disclosure:rotate-90 motion-reduce:transition-none" aria-hidden="true" /><span className="min-w-0 flex-1">{title}</span>{aside && <span className="shrink-0 text-xs text-fg-subtle">{aside}</span>}
  </summary>{children}</details>;
}
export function PlanView({ plan, projectName }: { plan: AssetPlan; projectName: string }) {
  return <article className="mx-auto max-w-3xl">
    <Link href={`/projects/${plan.projectId}`} className={`mb-6 inline-flex min-h-10 max-w-full items-center gap-2 rounded text-sm text-fg-muted hover:text-fg ${FOCUS}`}><ArrowLeft className="size-4 shrink-0 text-white" /><span className="truncate">{projectName}</span></Link>
    <header className="mb-8">
      <p className="mb-2 text-xs text-fg-muted">{plan.kind === "ui" ? "UI" : "Thumbnail"} · Written plan</p>
      <h1 className="break-words text-2xl font-semibold tracking-tight">{plan.title}</h1>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-fg-muted">{plan.brief.goal}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <a href={`/api/projects/${plan.projectId}/plans/${plan.id}?download=markdown`} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-surface ${FOCUS}`}><Download className="size-4 text-white" />Download plan</a>
        {plan.sourceChatId && <Link href={`/chats/${plan.sourceChatId}`} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-surface ${FOCUS}`}><MessageSquare className="size-4 text-white" />Open chat</Link>}
      </div>
    </header>
    <section aria-label="Concepts" className="space-y-8">
      {plan.concepts.map((concept, index) => <section key={concept.key} className="border-t border-line pt-6">
        <p className="mb-2 text-xs text-fg-subtle">Concept {index + 1}</p>
        <h2 className="break-words text-lg font-medium">{concept.title}</h2>
        <p className="mt-3 text-xs text-fg-subtle">Creative hypothesis</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-fg-muted">{concept.hypothesis}</p>
        <div className="mt-3"><Disclosure title="Composition & prompt"><p className="whitespace-pre-wrap rounded-lg border border-line p-4 text-sm leading-6">{concept.prompt}</p></Disclosure></div>
        {concept.assets.length > 0 && <div className="mt-4"><h3 className="mb-2 text-sm font-medium">Assets</h3><ul className="divide-y divide-line">{concept.assets.map((asset) => <li key={asset.key}><Disclosure title={asset.label} aside={asset.size.replace("x", " × ")}><p className="whitespace-pre-wrap pb-4 text-sm leading-6">{asset.prompt}</p></Disclosure></li>)}</ul></div>}
      </section>)}
    </section>
    <div className="mt-8 border-t border-line pt-4">
      <Disclosure title="Creative brief"><dl className="space-y-4 pb-4 text-sm leading-6"><div><dt className="text-fg-subtle">Gameplay promise</dt><dd className="whitespace-pre-wrap">{plan.brief.truthfulContent}</dd></div><div><dt className="text-fg-subtle">Visual direction</dt><dd className="whitespace-pre-wrap">{plan.brief.visualDirection}</dd></div>{plan.brief.avoid.length > 0 && <div><dt className="text-fg-subtle">Avoid</dt><dd><ul className="list-inside list-disc">{plan.brief.avoid.map((item, i) => <li key={i}>{item}</li>)}</ul></dd></div>}</dl></Disclosure>
      <Disclosure title={`Project context · v${plan.projectRevision}`}><dl className="space-y-3 pb-4 text-sm leading-6">{[["Game", plan.projectContext.game], ["Core loop", plan.projectContext.gameplay], ["Audience", plan.projectContext.audience], ["Visual style", plan.projectContext.artDirection], ["Constraints", plan.projectContext.constraints.join("\n")]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-fg-subtle">{label}</dt><dd className="whitespace-pre-wrap">{value}</dd></div>)}</dl></Disclosure>
    </div>
  </article>;
}
