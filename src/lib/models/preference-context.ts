import { createHash } from "node:crypto";
import { UNKNOWN_RECOMMENDATION_CONTEXT, type AutoRecommendationContext } from "./auto-recommendation.ts";

function scopedContext(ownerId: string, subscription: "none" | "active"): AutoRecommendationContext {
  if (!/^(guest|account):[a-f0-9-]{36}$/i.test(ownerId)) return UNKNOWN_RECOMMENDATION_CONTEXT;
  return { subscription, scope: createHash("sha256").update(`auto-recommendation:v1:${ownerId}`).digest("hex") };
}

/** Only a plan read for the verified session's current account is authoritative.
 * The existing credit_plan flag is also used by weekly-credit eligibility. Missing
 * rows, unfamiliar flags and storage failures must never be labelled free.
 */
export function accountRecommendationContext(ownerId: string, creditPlan: unknown): AutoRecommendationContext {
  return creditPlan === "free" ? scopedContext(ownerId, "none")
    : creditPlan === "subscribed" ? scopedContext(ownerId, "active") : UNKNOWN_RECOMMENDATION_CONTEXT;
}

/** Anonymous guests cannot hold account subscriptions. An existing session cookie
 * must never be mistaken for a guest after a failed/expired account lookup.
 */
export function guestRecommendationContext(hasAccountSession: boolean, guestOwnerId: string | null): AutoRecommendationContext {
  if (hasAccountSession || !guestOwnerId || !/^guest:[a-f0-9-]{36}$/i.test(guestOwnerId)) return UNKNOWN_RECOMMENDATION_CONTEXT;
  return scopedContext(guestOwnerId, "none");
}
