export const SKILL_CATALOG = [
  { id: "romanum-genre-analysis", name: "Genre analysis", description: "Find promising game patterns.", prompt: "Compare current Roblox game patterns, including Steal a and +1 incrementals." },
  { id: "romanum-game-design", name: "Game design", description: "Shape your next game.", prompt: "Help me design an original Roblox game using current market data." },
] as const;

export type SkillId = (typeof SKILL_CATALOG)[number]["id"];
export function isSkillId(id: unknown): id is SkillId {
  return typeof id === "string" && SKILL_CATALOG.some((skill) => skill.id === id);
}
