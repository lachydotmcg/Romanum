// node:process keeps this implementation on the server; the client imports types.ts only.
import { env } from "node:process";
import { MODEL_CATALOG, RATE_CARD_VERSION } from "./catalog.ts";
import type { ExecutionReviews, ModelReadiness, ModelsResponse, ProviderId } from "./types.ts";

const keyNames: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
};
/** Only the released DeepSeek assistant is reviewed. No env flag can enable new execution here. */
export const RELEASED_EXECUTION_REVIEWS: Readonly<ExecutionReviews> = Object.freeze({
  "deepseek-flash": Object.freeze({ adapterSupported: true, executionEnabled: true }),
});
type ServerEnvironment = Readonly<Record<string, string | undefined>>;
function serverOnly() {
  if (typeof window !== "undefined") throw new Error("Model readiness is server-only.");
}

/** Check per invocation, not at import time. Presence is not authentication or entitlement. */
export function readModelReadiness(
  environment: ServerEnvironment = env,
  reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS,
): ModelReadiness[] {
  serverOnly();
  return MODEL_CATALOG.map((model) => {
    const configured = typeof environment[keyNames[model.provider]] === "string" &&
      environment[keyNames[model.provider]]!.trim().length > 0;
    const adapterSupported = reviews[model.id]?.adapterSupported === true;
    const executionEnabled = reviews[model.id]?.executionEnabled === true;
    const selectable = configured && adapterSupported && executionEnabled;
    return {
      modelId: model.id, configured, adapterSupported, executionEnabled, selectable, entitlementVerified: false,
      reason: !configured ? "missing_key" : !adapterSupported ? "adapter_not_supported" : !executionEnabled ? "execution_disabled" : "ready",
    };
  });
}

/** Public allowlist: never spread environment, review objects, exceptions, or a provider client. */
export function publicModels(environment: ServerEnvironment = env): ModelsResponse {
  serverOnly();
  const readiness = readModelReadiness(environment);
  return { rateCardVersion: RATE_CARD_VERSION, models: MODEL_CATALOG.map((model, i) => ({ ...model, ...readiness[i] })) };
}
