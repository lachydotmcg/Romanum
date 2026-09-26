import type { ChartGame, RobloxChartId } from "./roblox";

export const PATTERNS = [
  { id: "steal-a", label: "Steal a…", description: "Titles built around stealing a collectible.", match: /\bsteal\s+(?:a|an)\b/i },
  { id: "plus-one", label: "+1 incrementals", description: "Titles promising incremental progress with +1.", match: /\+\s*1\b/i },
  { id: "grow-a", label: "Grow a…", description: "Titles built around growing or nurturing something.", match: /\bgrow\s+(?:a|an)\b/i },
  { id: "brainrot", label: "Brainrot", description: "Titles using the brainrot theme.", match: /\bbrainrots?\b/i },
  { id: "escape-obby", label: "Escape & obby", description: "Titles referencing escapes or obstacle courses.", match: /\b(?:escape|obby|obbies)\b/i },
  { id: "pets-eggs", label: "Pets & eggs", description: "Titles referencing pets, eggs or hatching.", match: /\b(?:pets?|eggs?|hatch|hatching)\b/i },
] as const;

export type PatternId = (typeof PATTERNS)[number]["id"];
export type ChartSample = { chart: RobloxChartId; games: ChartGame[] | null };
export type SampleGame = ChartGame & { charts: RobloxChartId[] };
export type PatternSignal = {
  id: PatternId;
  label: string;
  description: string;
  players: number;
  gameCount: number;
  medianPlayers: number;
  leaderShare: number | null;
  trendingCount: number;
  risingCount: number;
  games: SampleGame[];
};
export type GenreSignal = { name: string; players: number; gameCount: number; share: number };
export type MarketAnalysis = {
  assembledAt: string;
  availableCharts: RobloxChartId[];
  unavailableCharts: RobloxChartId[];
  sampleSize: number;
  samplePlayers: number;
  games: SampleGame[];
  patterns: PatternSignal[];
  genres: GenreSignal[];
};

// Update tags such as [+1 LUCK] are not evidence of a game's core theme.
export function matchingPatterns(name: string): PatternId[] {
  const title = name.normalize("NFKC").replace(/\[[^\]]*\]/g, " ");
  return PATTERNS.filter((pattern) => pattern.match.test(title)).map((pattern) => pattern.id);
}

/** A bounded chart sample, not a census or a measure of change over time. */
export function analyzeMarket(samples: ChartSample[], assembledAt = new Date().toISOString()): MarketAnalysis {
  const byId = new Map<number, SampleGame>();
  // Prefer the same chart's current-player values when a game occurs in several lists.
  const priority = ["top-playing-now", "top-trending", "up-and-coming", "top-earning"];
  const ordered = [...samples].sort((a, b) => priority.indexOf(a.chart) - priority.indexOf(b.chart));
  for (const { chart, games } of ordered) {
    for (const game of games ?? []) {
      if (game.sponsored || !Number.isSafeInteger(game.universeId) || game.universeId <= 0 ||
          !Number.isFinite(game.playing) || game.playing < 0) continue;
      const existing = byId.get(game.universeId);
      if (existing) {
        if (!existing.charts.includes(chart)) existing.charts.push(chart);
      } else {
        byId.set(game.universeId, { ...game, charts: [chart] });
      }
    }
  }
  const games = [...byId.values()].sort((a, b) => b.playing - a.playing || a.universeId - b.universeId);
  const samplePlayers = games.reduce((sum, game) => sum + game.playing, 0);
  const matches = new Map(games.map((game) => [game.universeId, matchingPatterns(game.name)]));
  const patterns = PATTERNS.map((pattern): PatternSignal => {
    const members = games.filter((game) => matches.get(game.universeId)?.includes(pattern.id));
    const players = members.reduce((sum, game) => sum + game.playing, 0);
    const middle = Math.floor(members.length / 2);
    const medianPlayers = !members.length ? 0 : members.length % 2
      ? members[middle].playing : (members[middle - 1].playing + members[middle].playing) / 2;
    return {
      id: pattern.id, label: pattern.label, description: pattern.description,
      players, gameCount: members.length, medianPlayers,
      leaderShare: players > 0 ? members[0].playing / players : null,
      trendingCount: members.filter((game) => game.charts.includes("top-trending")).length,
      risingCount: members.filter((game) => game.charts.includes("up-and-coming")).length,
      games: members,
    };
  }).sort((a, b) => b.players - a.players || b.gameCount - a.gameCount);

  const grouped = new Map<string, { players: number; gameCount: number }>();
  for (const game of games) {
    const genre = game.genre || "Unlisted";
    const group = grouped.get(genre) ?? { players: 0, gameCount: 0 };
    group.players += game.playing;
    group.gameCount++;
    grouped.set(genre, group);
  }
  return {
    assembledAt,
    availableCharts: samples.filter((sample) => sample.games !== null).map((sample) => sample.chart),
    unavailableCharts: samples.filter((sample) => sample.games === null).map((sample) => sample.chart),
    sampleSize: games.length, samplePlayers, games, patterns,
    genres: [...grouped].map(([name, group]) => ({ name, ...group, share: samplePlayers ? group.players / samplePlayers : 0 }))
      .sort((a, b) => b.players - a.players || a.name.localeCompare(b.name)),
  };
}
