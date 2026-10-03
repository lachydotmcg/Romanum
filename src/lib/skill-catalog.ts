export const SKILL_CATALOG = [
  { id: "romanum-genre-analysis", name: "Genre analysis", description: "Find promising game patterns.", prompt: "Compare current Roblox game patterns, including Steal a and +1 incrementals." },
  { id: "romanum-game-design", name: "Game design", description: "Shape your next game.", prompt: "Help me design an original Roblox game using current market data." },
  { id: "romanum-game-teardown", name: "Game teardown", description: "Learn from observed gameplay.", prompt: "Help me inspect a Roblox reference game and turn observations into a testable design hypothesis." },
  { id: "romanum-game-economy", name: "Game economy", description: "Balance progression and purchases.", prompt: "Help me review my game's economy and plan a fair, measurable purchase experiment." },
  { id: "romanum-player-onboarding", name: "Player onboarding", description: "Improve the first session.", prompt: "Help me plan a clearer first session for my game's audience." },
  { id: "romanum-thumbnail-design", name: "Thumbnail design", description: "Plan a thumbnail concept.", prompt: "Help me plan thumbnail concepts that show my game's actual gameplay." },
  { id: "romanum-ui-workflow", name: "UI workflow", description: "Reuse, design and assemble UI.", prompt: "Help me find or plan a reusable Roblox interface, then review its concept before making separate assets." },
  { id: "romanum-3d-workflow", name: "3D and Blender workflow", description: "Model assets from coherent references.", prompt: "Help me model a Roblox asset in Blender, reconcile its references and compare actual renders with the selected design." },
] as const;

export type SkillId = (typeof SKILL_CATALOG)[number]["id"];
export function isSkillId(id: unknown): id is SkillId {
  return typeof id === "string" && SKILL_CATALOG.some((skill) => skill.id === id);
}
