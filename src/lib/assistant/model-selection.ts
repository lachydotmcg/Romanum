import type OpenAI from "openai";
import { env } from "node:process";
import { quoteAssistantCall } from "./billing.ts";
import { RATE_CARD_VERSION } from "../models/catalog.ts";
import { reservationCredits } from "../models/estimate.ts";
import { parseModelSelection, routeModel } from "../models/route.ts";
import { readModelReadiness } from "../models/readiness.ts";
import type { ModelSelection, RouteDecision, RouteReason, TokenBudget } from "../models/types.ts";

type SelectedDecision = Extract<RouteDecision, { status: "selected" }>;
export type AssistantModelRoute = {
  modelSelection: ModelSelection;
  modelDecision: SelectedDecision | null;
  modelResolvedAt: string;
  /** Older queued payloads keep their original adapter and reservation policy. */
  legacy?: true;
};
type Request = Pick<OpenAI.Chat.ChatCompletionCreateParams, "model" | "messages" | "tools" | "max_tokens">;
type Environment = Readonly<Record<string, string | undefined>>;

const messages: Partial<Record<RouteReason, string>> = {
  invalid_selection: "Choose a valid model.",
  model_unavailable: "The selected model is unavailable. Choose another model to continue.",
  no_ready_model: "The AI assistant isn't connected.",
  capability_mismatch: "The selected model cannot support this request's tools or images.",
  context_limit: "The conversation exceeds the selected model's supported limits.",
  minimum_hold: "Not enough credits for the minimum reservation.",
  insufficient_balance: "Not enough credits for this request's reservation.",
};
export class ModelSelectionError extends Error {
  readonly status: number;
  readonly decision: RouteDecision;
  constructor(decision: RouteDecision) {
    super(messages[decision.reason] ?? "The model selection could not be validated.");
    this.name = "ModelSelectionError";
    this.decision = decision;
    this.status = decision.reason === "invalid_selection" || decision.reason === "invalid_request" ? 400
      : ["minimum_hold", "insufficient_balance"].includes(decision.reason) ? 402
      : decision.reason === "no_ready_model" ? 503 : decision.reason === "model_unavailable" ? 409 : 422;
  }
}
function blocked(reason: RouteReason): never {
  throw new ModelSelectionError({ status: "blocked", reason, fallback: null });
}

/** Omitted selections from older clients preserve DeepSeek; malformed supplied values never default. */
export function requestModelSelection(value: unknown, supplied: boolean): ModelSelection {
  if (!supplied) return { mode: "explicit", modelId: "deepseek-flash" };
  return parseModelSelection(value) ?? blocked("invalid_selection");
}
export function formModelSelection(form: FormData): ModelSelection {
  const values = form.getAll("modelSelection");
  if (!values.length) return requestModelSelection(undefined, false);
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].length > 256) blocked("invalid_selection");
  try { return requestModelSelection(JSON.parse(values[0] as string), true); }
  catch (error) { if (error instanceof ModelSelectionError) throw error; return blocked("invalid_selection"); }
}

/** A cheap availability check can reject an unavailable selection before opening an owner transaction. */
export function assertSelectionReady(selection: ModelSelection, environment: Environment = env): void {
  const readiness = readModelReadiness(environment);
  if (selection.mode === "explicit") {
    if (selection.modelId !== "deepseek-flash" || !readiness.find(model => model.modelId === selection.modelId)?.selectable) blocked("model_unavailable");
  } else if (!readiness.find(model => model.modelId === "deepseek-flash")?.selectable) blocked("no_ready_model");
}

/** Same conservative framing/image bounds as the released quote; checked against it below.
 * No browser token estimates, cache hints, balance, readiness or quotes enter this path.
 */
function requestBounds(request: Request): { budget: TokenBudget; images: boolean } {
  let images = 0;
  const json = JSON.stringify({ messages: request.messages, tools: request.tools }, (key, value) => {
    if (key !== "image_url") return value;
    if (!value || typeof value.url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.url)) blocked("invalid_request");
    images++;
    return { detail: value.detail, url: "[image]" };
  });
  const input = Buffer.byteLength(json, "utf8") + 2048 + request.messages.length * 64 + (request.tools?.length ?? 0) * 128 + images * 1024;
  return { budget: { inputTokens: input, maxInputTokens: input, outputTokens: request.max_tokens!, maxOutputTokens: request.max_tokens! }, images: images > 0 };
}

/** Resolve Auto exactly once from current server readiness and a trusted, fully framed request. */
export function resolveAssistantModel(selection: ModelSelection, request: Request, availableCredits: number, environment: Environment = env, at = new Date().toISOString()): AssistantModelRoute {
  const bounds = requestBounds(request);
  const decision = routeModel({ selection, availableCredits, budget: bounds.budget,
    capabilities: { text: true, tools: !!request.tools?.length, images: bounds.images }, at }, readModelReadiness(environment));
  if (decision.status !== "selected") throw new ModelSelectionError(decision);
  // The engine and released accounting support only this exact adapter, regardless of future catalog changes.
  if (decision.modelId !== "deepseek-flash") blocked("model_unavailable");
  let ceiling: number;
  try { ceiling = quoteAssistantCall({ ...request, model: decision.modelId }); }
  catch { return blocked("context_limit"); }
  if (ceiling !== decision.quote.reservationPriceNanoUsd || reservationCredits(ceiling) !== decision.quote.reservationCredits) blocked("model_unavailable");
  return { modelSelection: selection, modelDecision: decision, modelResolvedAt: at };
}

export function legacyAssistantModel(): AssistantModelRoute {
  return { modelSelection: { mode: "explicit", modelId: "deepseek-flash" }, modelDecision: null, modelResolvedAt: new Date().toISOString(), legacy: true };
}

/** Partial or malformed new payloads are not legacy payloads and cannot switch back to Auto. */
export function persistedAssistantModel(payload: Partial<AssistantModelRoute>): AssistantModelRoute {
  if (payload.modelSelection === undefined && payload.modelDecision === undefined && payload.modelResolvedAt === undefined && payload.legacy === undefined) return legacyAssistantModel();
  const selection = parseModelSelection(payload.modelSelection), decision = payload.modelDecision;
  if (!selection || payload.legacy !== undefined || !decision || decision.status !== "selected" || decision.modelId !== "deepseek-flash" ||
    (selection.mode === "explicit" ? selection.modelId !== decision.modelId || decision.reason !== "explicit_selection" : !["auto_affordable", "auto_cache_scenario"].includes(decision.reason)) ||
    decision.fallback !== null || decision.quote?.modelId !== decision.modelId || decision.quote.rateCardVersion !== RATE_CARD_VERSION ||
    !Number.isFinite(Date.parse(payload.modelResolvedAt ?? ""))) blocked("invalid_selection");
  return { modelSelection: selection, modelDecision: decision, modelResolvedAt: payload.modelResolvedAt! };
}

/** Revalidate the resolved ID, never reroute Auto. Existing atomic holds remain the balance authority.
 * Call before reservation and again from meteredStream's beforeSend hook, after the hold is obtained.
 */
export function revalidateAssistantModel(route: AssistantModelRoute, request: Request, environment: Environment = env): void {
  if (request.model !== "deepseek-flash") blocked("model_unavailable");
  if (route.legacy) {
    if (route.modelDecision !== null || route.modelSelection.mode !== "explicit" || route.modelSelection.modelId !== "deepseek-flash") blocked("invalid_selection");
    const readiness = readModelReadiness(environment).find(model => model.modelId === "deepseek-flash");
    if (!readiness?.selectable) blocked("model_unavailable");
    quoteAssistantCall(request);
    return;
  }
  const persisted = persistedAssistantModel(route);
  const current = resolveAssistantModel({ mode: "explicit", modelId: persisted.modelDecision!.modelId }, request, Number.MAX_SAFE_INTEGER, environment);
  if (current.modelDecision!.modelId !== persisted.modelDecision!.modelId) blocked("model_unavailable");
}
