import { z } from "zod";
import { MODEL_CATALOG, getModel } from "./catalog.ts";
import { quoteModel, validBudget } from "./estimate.ts";
import { MODEL_IDS, type CapabilityRequirements, type ModelDefinition, type ModelReadiness, type ModelSelection, type RouteDecision, type RouteRequest } from "./types.ts";

const selectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z.object({ mode: z.literal("explicit"), modelId: z.enum(MODEL_IDS) }).strict(),
]);
export function parseModelSelection(value: unknown): ModelSelection | null {
  const parsed = selectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const requirementsSchema = z.object({ text: z.boolean().optional(), tools: z.boolean().optional(), images: z.boolean().optional() }).strict();
function compatible(model: ModelDefinition, required: CapabilityRequirements): boolean {
  return (Object.keys(required) as (keyof CapabilityRequirements)[]).every((key) => !required[key] || model.capabilities[key]);
}
function ready(modelId: string, readiness: readonly ModelReadiness[]): boolean {
  const entries = readiness.filter((entry) => entry.modelId === modelId);
  // Conflicting/duplicate readiness cannot accidentally enable a choice.
  return entries.length === 1 && entries[0].configured === true && entries[0].adapterSupported === true &&
    entries[0].executionEnabled === true && entries[0].selectable === true && entries[0].reason === "ready";
}

/** Pure proposal only. Readiness and balances must be trusted server snapshots, rechecked before submission. */
export function routeModel(request: RouteRequest, readiness: readonly ModelReadiness[]): RouteDecision {
  const selection = parseModelSelection(request.selection);
  if (!selection) return { status: "blocked", reason: "invalid_selection", fallback: null };
  const required = requirementsSchema.safeParse(request.capabilities ?? {});
  if (!required.success || !validBudget(request.budget) || !Number.isSafeInteger(request.availableCredits) || request.availableCredits < 0 ||
    !Number.isFinite(Date.parse(request.at))) return { status: "blocked", reason: "invalid_request", fallback: null };
  const readyModels = MODEL_CATALOG.filter((model) => ready(model.id, readiness));
  const eligible = readyModels.filter((model) => compatible(model, required.data));
  const candidates = eligible.flatMap((model) => {
    try { return [{ model, quote: quoteModel(model.id, request.budget, request) }]; } catch { return []; }
  }).sort((a, b) => a.quote.estimatedPriceNanoUsd - b.quote.estimatedPriceNanoUsd ||
    a.quote.reservationPriceNanoUsd - b.quote.reservationPriceNanoUsd || a.model.id.localeCompare(b.model.id));
  const affordable = candidates.filter((candidate) => candidate.quote.reservationCredits <= request.availableCredits);
  const fallback = affordable[0] ? { modelId: affordable[0].model.id, quote: affordable[0].quote, reason: "affordable_alternative" as const } : null;
  if (selection.mode === "explicit") {
    const model = getModel(selection.modelId)!;
    const different = fallback?.modelId === model.id ? null : fallback;
    if (!ready(model.id, readiness)) return { status: "blocked", reason: "model_unavailable", modelId: model.id, fallback: different };
    if (!compatible(model, required.data)) return { status: "blocked", reason: "capability_mismatch", modelId: model.id, fallback: different };
    if (request.budget.cacheTtl && !model.cacheTtls.includes(request.budget.cacheTtl)) return { status: "blocked", reason: "invalid_request", modelId: model.id, fallback: different };
    const candidate = candidates.find((item) => item.model.id === model.id);
    if (!candidate) return { status: "blocked", reason: "context_limit", modelId: model.id, fallback: different };
    if (candidate.quote.reservationCredits > request.availableCredits) return {
      status: "blocked", reason: request.availableCredits < 2 ? "minimum_hold" : "insufficient_balance",
      modelId: model.id, quote: candidate.quote, fallback: different,
    };
    return { status: "selected", modelId: model.id, reason: "explicit_selection", quote: candidate.quote, fallback: null };
  }
  if (!eligible.length) return { status: "blocked", reason: readyModels.length ? "capability_mismatch" : "no_ready_model", fallback: null };
  if (request.budget.cacheTtl && eligible.every((model) => !model.cacheTtls.includes(request.budget.cacheTtl!))) return { status: "blocked", reason: "invalid_request", fallback: null };
  if (!candidates.length) return { status: "blocked", reason: "context_limit", fallback: null };
  if (!affordable.length) return { status: "blocked", reason: request.availableCredits < 2 ? "minimum_hold" : "insufficient_balance", fallback: null };
  const chosen = affordable[0];
  return { status: "selected", modelId: chosen.model.id,
    reason: chosen.quote.estimateBasis === "compatible_cache_scenario" ? "auto_cache_scenario" : "auto_affordable",
    quote: chosen.quote, fallback: null };
}
