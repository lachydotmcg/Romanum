/** Per successful hosted-assistant lookup. Public pages and MCP do not use this tariff. */
export const TOOL_FEE_CREDITS = 0.06;
export const TOOL_FEE_NANO_USD = 600_000;

export const BILLED_TOOLS = [
  "load_skill", "search_games", "get_game_stats", "get_game_history",
  "get_roblox_charts", "get_market_analysis", "research_game_idea", "estimate_game_earnings",
] as const;
export type BilledTool = (typeof BILLED_TOOLS)[number];
export const isBilledTool = (name: string): name is BilledTool => BILLED_TOOLS.some(tool => tool === name);
