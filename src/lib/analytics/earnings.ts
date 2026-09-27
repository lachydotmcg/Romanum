import { z } from "zod";

// Official rates checked 2026-09-27. Applies to newly earned balances only.
// https://en.help.roblox.com/hc/en-us/articles/13061189551124-Developer-Exchange-Help-and-Information-Page
// https://create.roblox.com/docs/production/monetization/18-plus-devex-rate
export const DEVEX = {
  standard: 0.0038,
  eligibleUs18: 0.0054,
  checkedAt: "2026-09-27",
  source: "https://en.help.roblox.com/hc/en-us/articles/13061189551124-Developer-Exchange-Help-and-Information-Page",
} as const;

export const EARNINGS_INPUT = z.object({
  averageCcu: z.number().finite().min(0).max(1_000_000_000),
  days: z.number().int().min(1).max(366),
  lowRobuxPerPlayerHour: z.number().finite().min(0).max(1_000_000),
  highRobuxPerPlayerHour: z.number().finite().min(0).max(1_000_000),
  eligibleUs18Percent: z.number().finite().min(0).max(100).default(0),
}).strict().refine((input) => input.lowRobuxPerPlayerHour <= input.highRobuxPerPlayerHour, {
  message: "High must be at least low.", path: ["highRobuxPerPlayerHour"],
});

/** A scenario, never an observation or confidence interval. Genre has no invented multiplier.
 * Rates are NET Earned Robux per player-hour, so no platform fee is deducted a second time.
 * USD is a pre-tax conversion, not profit, a payout guarantee, or a Robux purchase price.
 */
export function estimateEarnings(input: unknown) {
  const value = EARNINGS_INPUT.parse(input);
  const playerHours = value.averageCcu * 24 * value.days;
  const low = playerHours * value.lowRobuxPerPlayerHour;
  const high = playerHours * value.highRobuxPerPlayerHour;
  const eligibleShare = value.eligibleUs18Percent / 100;
  const devExRate = DEVEX.standard * (1 - eligibleShare) + DEVEX.eligibleUs18 * eligibleShare;
  return { playerHours, robux: { low, high }, usd: { low: low * devExRate, high: high * devExRate }, devExRate };
}
