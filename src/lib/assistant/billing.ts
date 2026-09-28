import type OpenAI from "openai";
import type { Database } from "../history/database.ts";
import { CREDIT_MARKUP, modelPricing, type CallUsage } from "../credits/pricing.ts";
import { finishUnreportedUsage, reserveUsage, settleUsage } from "../credits/usage-holds.ts";
import { isBilledTool } from "../credits/tool-pricing.ts";
import { finishToolUsage, reserveToolUsage } from "../credits/tool-usage.ts";
import type { ToolOutcome } from "./tools.ts";

type Request = Pick<OpenAI.Chat.ChatCompletionCreateParams, "model" | "messages" | "tools" | "max_tokens">;
type ReportedUsage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };

export interface AssistantBilling {
  reserve(maxPriceNanoUsd: number): Promise<string>;
  settle(id: string, call: CallUsage): Promise<void>;
  finish(id: string, uncertain: boolean): Promise<void>;
  tool(name: string, execute: () => Promise<ToolOutcome>, signal: AbortSignal): Promise<ToolOutcome>;
  readonly credits: number;
}

export function assistantBilling(db: Database, ownerId: string, feature: "ask" | "chat"): AssistantBilling {
  let credits = 0;
  return {
    get credits() { return credits; },
    async reserve(maxPriceNanoUsd) { return (await reserveUsage(db, { ownerId, feature, maxPriceNanoUsd })).id; },
    async settle(id, call) { credits += (await settleUsage(db, { ownerId, id, call })).credits; },
    async finish(id, uncertain) { await finishUnreportedUsage(db, { ownerId, id, uncertain }); },
    async tool(name, execute, signal) {
      signal.throwIfAborted();
      if (!isBilledTool(name)) return execute();
      const id = await reserveToolUsage(db, { ownerId, feature, tool: name });
      let outcome: ToolOutcome;
      try {
        signal.throwIfAborted();
        outcome = await execute();
      } catch (error) {
        await finishToolUsage(db, { ownerId, id, success: false });
        throw error;
      }
      const unavailable = outcome.ok && outcome.result && typeof outcome.result === "object"
        && "status" in outcome.result && outcome.result.status === "unavailable";
      const charged = await finishToolUsage(db, { ownerId, id, success: outcome.ok && !unavailable && !signal.aborted });
      credits += charged;
      return outcome;
    },
  };
}

/**
 * Conservative ceiling, not a charge. UTF-8 bytes overestimate text tokens;
 * framing has additional padding. Peak, uncached rates cover cache misses and
 * calls crossing a pricing boundary. The output cap includes reasoning tokens.
 * DeepSeek caps image encoding at 1024 tokens per image (vision guide, 2026-09-28).
 */
export function quoteAssistantCall(request: Request): number {
  if (request.model !== "deepseek-flash") throw new Error("This model needs a reviewed reservation policy.");
  if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! < 1 || request.max_tokens! > 16_000) {
    throw new Error("A bounded output limit is required.");
  }
  let images = 0;
  const json = JSON.stringify({ messages: request.messages, tools: request.tools }, (key, value) => {
    if (key !== "image_url") return value;
    if (!value || typeof value.url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.url)) {
      throw new Error("Only validated inline reference images are supported.");
    }
    images++;
    return { detail: value.detail, url: "[image]" };
  });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > 2_000_000 || images > 3) throw new Error("The conversation is too large.");
  const input = bytes + 2048 + request.messages.length * 64 + (request.tools?.length ?? 0) * 128 + images * 1024;
  const rates = modelPricing(request.model).rates;
  return Math.ceil((input * rates.input + request.max_tokens! * rates.output) * 1000 * CREDIT_MARKUP);
}

export function reportedCallUsage(at: Date, usage: ReportedUsage): CallUsage {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const cachedInput = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const input = usage.prompt_cache_miss_tokens ?? usage.prompt_tokens - cachedInput;
  if (![usage.prompt_tokens, usage.completion_tokens, cachedInput, input].every(valid) || input + cachedInput !== usage.prompt_tokens) {
    throw new Error("The provider returned invalid usage.");
  }
  return { model: "deepseek-flash", at, input, cachedInput, output: usage.completion_tokens };
}

// These responses explicitly reject the request. Timeouts, connection failures,
// aborts and server errors are ambiguous: keep their hold for reconciliation.
function rejected(error: unknown): boolean {
  return !!error && typeof error === "object" && "status" in error && [400, 401, 402, 403, 404, 413, 422, 429].includes(Number(error.status));
}

export async function* meteredStream(
  client: OpenAI,
  params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  billing: AssistantBilling,
  signal: AbortSignal,
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  const id = await billing.reserve(quoteAssistantCall(params));
  const at = new Date();
  let sent = false;
  let failure: unknown;
  let usage: CallUsage | undefined;
  try {
    signal.throwIfAborted();
    sent = true;
    // One reservation funds one attempt. Hidden SDK retries could incur a second bill.
    const stream = await client.chat.completions.create(params, { signal, maxRetries: 0 });
    for await (const chunk of stream) {
      if (chunk.usage) usage = reportedCallUsage(at, chunk.usage);
      yield chunk;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (usage) await billing.settle(id, usage);
    else await billing.finish(id, sent && !rejected(failure));
  }
  if (!usage) throw new Error("The provider did not report usage.");
}

export async function meteredCompletion(
  client: OpenAI,
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  billing: AssistantBilling,
  signal: AbortSignal,
  timeout: number,
): Promise<OpenAI.Chat.ChatCompletion> {
  const id = await billing.reserve(quoteAssistantCall(params));
  const at = new Date();
  let sent = false;
  let failure: unknown;
  let usage: CallUsage | undefined;
  try {
    signal.throwIfAborted();
    sent = true;
    const completion = await client.chat.completions.create(params, { signal, timeout, maxRetries: 0 });
    if (completion.usage) usage = reportedCallUsage(at, completion.usage);
    if (!usage) throw new Error("The provider did not report usage.");
    return completion;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (usage) await billing.settle(id, usage);
    else await billing.finish(id, sent && !rejected(failure));
  }
}
