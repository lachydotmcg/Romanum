export const SKILL_CATALOG = [
  { id: "romanum-genre-analysis", name: "Genre analysis", description: "Find promising game patterns.", prompt: "Compare current Roblox game patterns, including Steal a and +1 incrementals." },
  { id: "romanum-game-design", name: "Game design", description: "Shape your next game.", prompt: "Help me design an original Roblox game using current market data." },
  { id: "romanum-player-onboarding", name: "Player onboarding", description: "Improve the first session.", prompt: "Help me plan a clearer first session for my game's audience." },
  { id: "romanum-thumbnail-design", name: "Thumbnail design", description: "Plan a thumbnail concept.", prompt: "Help me plan thumbnail concepts that show my game's actual gameplay." },
] as const;

export type SkillId = (typeof SKILL_CATALOG)[number]["id"];
export function isSkillId(id: unknown): id is SkillId {
  return typeof id === "string" && SKILL_CATALOG.some((skill) => skill.id === id);
}
