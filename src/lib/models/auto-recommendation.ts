/** UI advice only. Subscription state never controls model access or credit spending. */
export type AutoRecommendationContext = {
  subscription: "none" | "active" | "unknown";
  /** Opaque owner scope; never an account ID, session token or guest cookie. */
  scope: string | null;
};

export const UNKNOWN_RECOMMENDATION_CONTEXT: AutoRecommendationContext = { subscription: "unknown", scope: null };
const SCOPE = /^[a-f0-9]{64}$/;

export function parseAutoRecommendationContext(value: unknown): AutoRecommendationContext {
  if (!value || typeof value !== "object") return UNKNOWN_RECOMMENDATION_CONTEXT;
  const context = value as Partial<AutoRecommendationContext>;
  if (!["none", "active", "unknown"].includes(context.subscription ?? "") ||
    typeof context.scope !== "string" || !SCOPE.test(context.scope)) return UNKNOWN_RECOMMENDATION_CONTEXT;
  return { subscription: context.subscription!, scope: context.scope };
}

/** Record the first shown recommendation synchronously, before another click or a reload.
 * This browser preference follows the existing owner identity across Ask and Chats. If
 * persistence is unavailable, skip the advice so it cannot become a repeated prompt.
 */
export function claimAutoRecommendation(context: AutoRecommendationContext, storage: Pick<Storage, "getItem" | "setItem">): boolean {
  if (context.subscription !== "none" || !context.scope || !SCOPE.test(context.scope)) return false;
  const key = `romanum:auto-recommendation:v1:${context.scope}`;
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, "seen");
    return storage.getItem(key) === "seen";
  } catch { return false; }
}
