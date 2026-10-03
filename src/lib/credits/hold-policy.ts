import { randomUUID } from "node:crypto";
import { CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY, pricingPolicyVersion, type PricingPolicyVersion } from "./pricing-policy.ts";

/** RFC 9562 UUIDv8, prefix 2502, leaves 106 random bits. No new database column/DDL.
 * Existing server-created UUIDv4 holds keep the original policy across releases.
 * The identifier is server-owned; it is never an authorization capability.
 */
export function pricingHoldId(version: PricingPolicyVersion = CURRENT_PRICING_POLICY): string {
  pricingPolicyVersion(version);
  const id = randomUUID();
  return version === LEGACY_PRICING_POLICY ? id : `2502${id.slice(4, 14)}8${id.slice(15)}`;
}
export function holdPricingPolicy(id: string): PricingPolicyVersion {
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return LEGACY_PRICING_POLICY;
  if (/^2502[a-f0-9]{4}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return CURRENT_PRICING_POLICY;
  throw new Error("Unknown usage-hold pricing policy.");
}
