import { readFile } from "node:fs/promises";
import path from "node:path";
import { isSkillId, SKILL_CATALOG } from "../skill-catalog.ts";

/** The repository files are the source for both downloads and the assistant. */
export async function loadSkill(id: unknown) {
  if (!isSkillId(id)) throw new Error("Unknown Romanum skill.");
  const source = await readFile(path.join(process.cwd(), "skills", id, "SKILL.md"), "utf8");
  const instructions = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  const metadata = SKILL_CATALOG.find((skill) => skill.id === id)!;
  return { ...metadata, source, instructions };
}
