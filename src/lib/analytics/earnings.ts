import { z } from "zod";

// Official conversion rates checked 2026-09-27. Applies to newly earned balances only.
// https://en.help.roblox.com/hc/en-us/articles/13061189551124-Developer-Exchange-Help-and-Information-Page
// https://create.roblox.com/docs/production/monetization/18-plus-devex-rate
export const DEVEX = {
  standard: 0.0038,
  eligibleUs18: 0.0054,
  checkedAt: "2026-09-27",
  source: "https://en.help.roblox.com/hc/en-us/articles/13061189551124-Developer-Exchange-Help-and-Information-Page",
} as const;

export const EARNINGS_MODEL_VERSION = "ccu-genre-v1";
/** Initial model assumptions: NET Earned Robux per player-hour. These rounded bands
 * are heuristics, not measured averages or confidence intervals. Coefficients are
 * versioned and published in /analytics/earnings-method. Private connected metrics
 * must not calibrate this model without enforced consent and deletion support.
 * General uses the full envelope of genre bands when a genre is missing/unrecognized.
 */
export const GENRE_RATES = {
  General: [0.7, 6], Action: [2, 4], Adventure: [1.8, 3.6], Education: [0.7, 1.4], Entertainment: [1.3, 2.5],
  "Obby & Platformer": [1.2, 2.5], "Party & Casual": [1.1, 2.3], Puzzle: [0.9, 1.9],
  "Roleplay & Avatar Sim": [1.6, 3.2], RPG: [2.8, 5.5], Shooter: [2.2, 4.3],
  Shopping: [1, 2.8], Simulation: [3.1, 6], Social: [0.8, 1.8],
  "Sports & Racing": [1.8, 3.6], Strategy: [2.4, 4.8], Survival: [1.8, 3.6], "Utility & Other": [0.7, 1.6],
} as const;
export type EarningsGenre = keyof typeof GENRE_RATES;
export function earningsGenre(genre: string | null | undefined): EarningsGenre {
  const primary = genre?.split("/")[0].trim().toLowerCase();
  return (Object.keys(GENRE_RATES) as EarningsGenre[]).find((name) => name.toLowerCase() === primary) ?? "General";
}

export const EARNINGS_INPUT = z.object({
  ccu: z.number().finite().min(0).max(1_000_000_000),
  days: z.number().int().min(1).max(366).default(30),
  genre: z.string().max(150).nullable().optional(),
  basis: z.enum(["current", "average"]).default("current"),
}).strict();

/** Projects constant CCU for the chosen period. No database, inferred historical average,
 * second platform-fee deduction or assumed enhanced DevEx eligibility. USD is pre-tax. */
export function estimateEarnings(input: unknown) {
  const { ccu, days, genre, basis } = EARNINGS_INPUT.parse(input);
  const modelGenre = earningsGenre(genre), rates = GENRE_RATES[modelGenre];
  const playerHours = ccu * 24 * days, low = playerHours * rates[0], high = playerHours * rates[1];
  return { kind: "estimate" as const, modelVersion: EARNINGS_MODEL_VERSION, basis, ccu, days, genre: modelGenre,
    playerHours, robux: { low, high }, usd: { low: low * DEVEX.standard, high: high * DEVEX.standard },
    devExRate: DEVEX.standard, method: "/analytics/earnings-method" };
}
export type EarningsEstimate = ReturnType<typeof estimateEarnings>;

export function currentEarnings(game: { playing: number; genre?: string | null }, days = 30) {
  if (!Number.isFinite(game.playing) || game.playing < 0 || game.playing > 1_000_000_000) return null;
  return estimateEarnings({ ccu: game.playing, genre: game.genre?.slice(0, 150), days, basis: "current" });
}

export function sumEarnings(games: { playing: number; genre?: string | null }[], days = 30) {
  return games.reduce((total, game) => {
    const estimate = currentEarnings(game, days);
    return { low: total.low + (estimate?.robux.low ?? 0), high: total.high + (estimate?.robux.high ?? 0) };
  }, { low: 0, high: 0 });
}
