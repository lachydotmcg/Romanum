import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSkill } from "../src/lib/assistant/skills.ts";
import { SKILL_CATALOG } from "../src/lib/skill-catalog.ts";

test("the assistant and downloads read the actual repository skill files", async () => {
  for (const { id } of SKILL_CATALOG) {
    const skill = await loadSkill(id);
    const disk = await readFile(`skills/${id}/SKILL.md`, "utf8");
    assert.equal(skill.source, disk);
    assert.ok(skill.instructions.startsWith("# Roblox"));
    assert.ok(!skill.instructions.startsWith("---"));
    assert.ok(skill.instructions.length > 500);
  }
});

test("skill loading only permits registered skills, preventing arbitrary file access", async () => {
  for (const id of ["../../.env.local", "../romanum-game-design", "", null, {}, "unknown"]) {
    await assert.rejects(loadSkill(id), /Unknown Romanum skill/);
  }
});
