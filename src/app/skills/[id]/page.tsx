import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { AssistantMarkdown } from "@/components/assistant/markdown";
import { SkillsMark } from "@/components/skills-mark";
import { loadSkill } from "@/lib/assistant/skills";
import { isSkillId, SKILL_CATALOG } from "@/lib/skill-catalog";

type Props = { params: Promise<{ id: string }> };

export function generateStaticParams() {
  return SKILL_CATALOG.map(({ id }) => ({ id }));
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: SKILL_CATALOG.find((skill) => skill.id === id)?.name ?? "Skills" };
}

export default async function SkillGuidePage({ params }: Props) {
  const { id } = await params;
  if (!isSkillId(id)) notFound();
  const skill = await loadSkill(id);

  return (
    <article className="max-w-3xl">
      <Link href="/skills" className="inline-flex items-center gap-1.5 rounded text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">
        <ArrowLeft className="size-3.5 text-white" aria-hidden="true" /> Skills
      </Link>
      <header className="mt-6 mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div className="flex items-center gap-3">
          <SkillsMark className="size-7 text-fg-muted" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">{skill.name}</h1>
        </div>
        <a href={`/api/skills/${skill.id}`} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">
          <Download className="size-3.5 text-white" aria-hidden="true" /> Download
        </a>
      </header>
      <div className="text-sm leading-7 text-fg-muted">
        <AssistantMarkdown text={skill.instructions} />
      </div>
    </article>
  );
}
