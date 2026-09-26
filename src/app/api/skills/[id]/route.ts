import { isSkillId } from "@/lib/skill-catalog";
import { loadSkill } from "@/lib/assistant/skills";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSkillId(id)) return Response.json({ error: "Skill not found." }, { status: 404 });
  const skill = await loadSkill(id);
  return new Response(skill.source, { headers: {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${id}-SKILL.md"`,
    "x-content-type-options": "nosniff",
  } });
}
