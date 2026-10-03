/** Historical policies remain available for held requests and immutable receipts. */
export const LEGACY_PRICING_POLICY = "legacy-credit-policy-v1";
export const CURRENT_PRICING_POLICY = "credit-policy-2p5-v2";
export type PricingPolicyVersion = typeof LEGACY_PRICING_POLICY | typeof CURRENT_PRICING_POLICY;
export const PRICING_POLICIES = Object.freeze({
  [LEGACY_PRICING_POLICY]: Object.freeze({ numerator: 165, denominator: 100, markup: 1.65 }),
  [CURRENT_PRICING_POLICY]: Object.freeze({ numerator: 5, denominator: 2, markup: 2.5 }),
});
export function pricingPolicyVersion(value: unknown): PricingPolicyVersion {
  if (value !== LEGACY_PRICING_POLICY && value !== CURRENT_PRICING_POLICY) throw new Error("Unknown credit pricing policy.");
  return value;
}
/** Missing policy in a previously persisted quote means the original 1.65x policy. */
export function quotePricingPolicy(quote: { pricingPolicyVersion?: unknown }): PricingPolicyVersion {
  return quote.pricingPolicyVersion === undefined ? LEGACY_PRICING_POLICY : pricingPolicyVersion(quote.pricingPolicyVersion);
}
function amount(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid monetary quantity.");
  return BigInt(value);
}
function result(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Price exceeds the safe accounting limit.");
  return Number(value);
}
function rounded(numerator: bigint, denominator: bigint, mode: "round" | "ceil"): number {
  return result(mode === "ceil" ? (numerator + denominator - BigInt(1)) / denominator : (BigInt(2) * numerator + denominator) / (BigInt(2) * denominator));
}
export function markedUpPrice(cost: number, version: PricingPolicyVersion = CURRENT_PRICING_POLICY, mode: "round" | "ceil" = "round"): number {
  const units = amount(cost), policy = PRICING_POLICIES[pricingPolicyVersion(version)];
  if (version === LEGACY_PRICING_POLICY) {
    const value = mode === "ceil" ? Math.ceil(cost * policy.markup) : Math.round(cost * policy.markup);
    amount(value); return value;
  }
  return rounded(units * BigInt(policy.numerator), BigInt(policy.denominator), mode);
}
function decimal(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid token rate.");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > 9) throw new Error("Unsupported token rate precision.");
  return { numerator: BigInt(match[1] + (match[2] ?? "")), denominator: BigInt(10) ** BigInt(match[2]?.length ?? 0) };
}
/** Exact USD/1M -> nano-USD conversion. Sum fractions before rounding once. */
export function tokenCost(parts: readonly { tokens: number; rate: number; multiplier?: number }[], mode: "round" | "ceil" = "ceil"): number {
  let numerator = BigInt(0), denominator = BigInt(1);
  for (const part of parts) {
    const rate = decimal(part.rate), multiplier = decimal(part.multiplier ?? 1);
    const nextDenominator = rate.denominator * multiplier.denominator;
    const nextNumerator = amount(part.tokens) * rate.numerator * multiplier.numerator * BigInt(1000);
    numerator = numerator * nextDenominator + nextNumerator * denominator;
    denominator *= nextDenominator;
  }
  return rounded(numerator, denominator, mode);
}
