import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { env } from "node:process";
import { z } from "zod";
import { getModel } from "../catalog.ts";
import { costUsage, normalizeUsage } from "../usage.ts";
import { canonicalTime, compileWire, safeJson } from "./wire.ts";
import { NATIVE_INPUT_CAPACITY } from "./native-capacity.ts";
import { providerFailureDiagnostic } from "./failure-diagnostics.ts";
import type { NormalizedUsage } from "../types.ts";
import type { AdapterErrorCode, AnthropicAdapterOptions, AnthropicCallOptions, AnthropicRequest,
  AnthropicResult, AnthropicStopReason, AnthropicOutputBlock, JsonValue, ProviderFailurePhase, ToolCall } from "./types.ts";

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_ADAPTER_VERSION = "anthropic-messages-v2";
export const ANTHROPIC_REQUEST_FORMAT = "anthropic-messages-json-v1";
export const ANTHROPIC_LIMITS = Object.freeze({ requestBytes: 8 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  eventBytes: 256 * 1024, textBytes: 1024 * 1024, toolJsonBytes: 64 * 1024, toolCalls: 16, blocks: 128, events: 20_000 });
const messages: Record<AdapterErrorCode, string> = {
  execution_disabled: "This provider has not been enabled.", missing_key: "This provider is unavailable.",
  invalid_request: "The model request is invalid.", unsupported_capability: "This adapter does not support the requested capability.",
  unsupported_model: "This adapter does not support the selected model.", cancelled: "The model request was cancelled.",
  timeout: "The model request timed out.", network_error: "The provider connection failed.",
  provider_unavailable: "The provider is unavailable.", provider_busy: "The provider is busy.", provider_error: "The provider request failed.",
  invalid_response: "The provider response could not be validated.", model_mismatch: "The provider did not return the selected model.",
  incomplete_stream: "The provider response ended before completion.", response_limit: "The provider response exceeded adapter limits.",
  consumer_error: "The response could not be delivered.",
};
class Fault extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode) { super(messages[code]); this.name = "AnthropicAdapterError"; this.code = code; }
}
function fail(code: AdapterErrorCode): never { throw new Fault(code); }
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_response");
  return value as Record<string, unknown>;
};
const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const jsonObject = z.record(z.string(), z.unknown());
const call = z.object({ id, name, input: jsonObject }).strict();
const opaque = z.string().min(1).max(ANTHROPIC_LIMITS.toolJsonBytes);
const nativeBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool_use"), id, name, input: jsonObject }).strict(),
  z.object({ type: z.literal("thinking"), thinking: z.literal(""), signature: opaque }).strict(),
  z.object({ type: z.literal("redacted_thinking"), data: opaque }).strict(),
]);
const continuation = z.object({ provider: z.literal("anthropic"), modelId: z.string(), prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.array(nativeBlock).min(1).max(ANTHROPIC_LIMITS.blocks) }).strict();
const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal("image"), mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().min(4).max(7 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]);
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.union([z.string().min(1), z.array(part).min(1).max(64)]) }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(call).max(ANTHROPIC_LIMITS.toolCalls).optional(), continuation: continuation.optional() }).strict(),
  z.object({ role: z.literal("tool"), toolCallId: id, content: z.string(), isError: z.boolean().optional() }).strict(),
]);
const requestSchema = z.object({ modelId: z.string(), system: z.string().optional(), messages: z.array(message).min(1).max(512),
  tools: z.array(z.object({ name, description: z.string().max(16_384), inputSchema: jsonObject }).strict()).max(64).optional(),
  maxTokens: z.number().int().min(1).max(16_000), maxInputTokens: z.number().int().min(1).max(1_000_000),
  stream: z.boolean().optional(), cacheTtl: z.enum(["5m", "1h"]).optional(),
  capabilities: z.object({ text: z.boolean().optional(), tools: z.boolean().optional(), images: z.boolean().optional() }).strict().optional(),
}).strict();

/** Bound JSON before stringification or tool return; reject values JSON would silently omit. */
function checkedJson(value: unknown, code: AdapterErrorCode, maxBytes: number): string {
  try { return safeJson(value, maxBytes); } catch { return fail(code); }
}
type WireBlock = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: WireBlock[] };
export type AnthropicWireRequest = { model: string; max_tokens: number; stream: boolean; messages: WireMessage[];
  system?: string; tools?: WireBlock[]; cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" };
  service_tier: "standard_only"; inference_geo?: "global"; thinking?: { type: "adaptive"; display: "omitted" } };
function policy(modelId: string) {
  return { service_tier: "standard_only" as const,
    ...(modelId !== "claude-haiku-4-5-20251001" ? { inference_geo: "global" as const,
      thinking: { type: "adaptive" as const, display: "omitted" as const } } : {}) };
}
function prefixHash(model: string, system: string | undefined, tools: WireBlock[] | undefined, cacheTtl: string | undefined, history: WireMessage[]): string {
  return createHash("sha256").update(JSON.stringify({ model, system: system || null, tools: tools ?? [], cacheTtl: cacheTtl ?? null,
    ...policy(model), messages: history })).digest("hex");
}

/** Pure translation; does not look up keys, enable the catalog or submit anything. */
export function translateAnthropicRequest(value: AnthropicRequest): AnthropicWireRequest {
  checkedJson(value, "invalid_request", ANTHROPIC_LIMITS.requestBytes);
  const selected = getModel(value?.modelId);
  if (!selected || selected.provider !== "anthropic") fail("unsupported_model");
  if (value.capabilities && Object.keys(value.capabilities).some((key) => !["text", "tools", "images"].includes(key))) fail("unsupported_capability");
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) fail("invalid_request");
  const request = parsed.data;
  if (request.maxInputTokens > NATIVE_INPUT_CAPACITY[selected.id]! || request.maxTokens > selected.maxOutputTokens) fail("invalid_request");
  if (request.capabilities && Object.entries(request.capabilities).some(([key, required]) => required && !selected.capabilities[key as keyof typeof selected.capabilities])) fail("unsupported_capability");
  const tools = request.tools?.map((tool) => {
    checkedJson(tool.inputSchema, "invalid_request", ANTHROPIC_LIMITS.toolJsonBytes);
    if (tool.inputSchema.type !== "object") fail("invalid_request");
    return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
  });
  if (new Set(tools?.map((tool) => tool.name)).size !== (tools?.length ?? 0)) fail("invalid_request");
  const history: WireMessage[] = [], seen = new Set<string>();
  let pending = new Set<string>();
  const append = (role: WireMessage["role"], content: WireBlock[]) => {
    const prior = history.at(-1);
    if (prior?.role === role) prior.content.push(...content); else history.push({ role, content });
  };
  for (const entry of request.messages) {
    if (entry.role === "tool") {
      if (!pending.delete(entry.toolCallId)) fail("invalid_request");
      append("user", [{ type: "tool_result", tool_use_id: entry.toolCallId, content: entry.content,
        ...(entry.isError === undefined ? {} : { is_error: entry.isError }) }]);
    } else {
      if (pending.size) fail("invalid_request");
      if (entry.role === "user") {
        const content = typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content.map((block) => block.type === "text"
          ? { type: "text", text: block.text } : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } });
        append("user", content);
      } else {
        let content: WireBlock[] = entry.content ? [{ type: "text", text: entry.content }] : [];
        if (entry.continuation) {
          const native = entry.continuation;
          if (native.modelId !== selected.id || native.prefixHash !== prefixHash(selected.id, request.system, tools, request.cacheTtl, history)) fail("invalid_request");
          const nativeText = native.content.filter((block) => block.type === "text").map((block) => block.text).join("");
          const nativeCalls = native.content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, input: block.input }));
          if (nativeText !== entry.content || JSON.stringify(nativeCalls) !== JSON.stringify(entry.toolCalls ?? [])) fail("invalid_request");
          content = native.content;
        }
        pending = new Set((entry.toolCalls ?? []).map((tool) => tool.id));
        if (pending.size !== (entry.toolCalls?.length ?? 0)) fail("invalid_request");
        for (const tool of entry.toolCalls ?? []) {
          if (seen.has(tool.id)) fail("invalid_request");
          seen.add(tool.id);
          checkedJson(tool.input, "invalid_request", ANTHROPIC_LIMITS.toolJsonBytes);
          if (!entry.continuation) content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
        }
        if (!content.length) fail("invalid_request");
        append("assistant", content);
      }
    }
  }
  // No assistant prefill; every historical tool call needs immediate, complete matching results.
  if (pending.size || history[0]?.role !== "user" || history.at(-1)?.role !== "user") fail("invalid_request");
  const body: AnthropicWireRequest = { model: selected.id, max_tokens: request.maxTokens, stream: request.stream ?? true, messages: history, ...policy(selected.id),
    ...(request.system ? { system: request.system } : {}), ...(tools?.length ? { tools } : {}),
    ...(request.cacheTtl ? { cache_control: { type: "ephemeral", ttl: request.cacheTtl } } : {}) };
  checkedJson(body, "invalid_request", ANTHROPIC_LIMITS.requestBytes);
  return body;
}

export function compileAnthropicRequest(request: AnthropicRequest) {
  return compileWire(translateAnthropicRequest(request), {
    endpoint: ANTHROPIC_ENDPOINT, apiVersion: ANTHROPIC_VERSION, requestFormat: ANTHROPIC_REQUEST_FORMAT,
  }, ANTHROPIC_LIMITS.requestBytes);
}

type Block = { type: "text"; text: string; closed: boolean } | {
  type: "tool_use"; id: string; name: string; initial: Record<string, unknown>; json: string; closed: boolean;
} | { type: "thinking"; signature: string; closed: boolean } | { type: "redacted_thinking"; data: string; closed: boolean };
const stopReasons: readonly string[] = ["end_turn", "tool_use", "max_tokens", "model_context_window_exceeded", "refusal"];
class MessageState {
  readonly request: AnthropicRequest; readonly at: string; readonly onText?: AnthropicCallOptions["onText"];
  readonly prefix: string;
  blocks: Block[] = []; rawUsage: Record<string, unknown> = {}; usage: NormalizedUsage | null = null;
  started = false; stopped = false; usageComplete = false; messageId = ""; stopReason: AnthropicStopReason | null = null;
  deltas = 0; textBytes = 0; toolIds = new Set<string>();
  constructor(request: AnthropicRequest, at: string, prefix: string, onText?: AnthropicCallOptions["onText"]) { this.request = request; this.at = at; this.prefix = prefix; this.onText = onText; }
  mergeUsage(value: unknown) {
    const incoming = object(value), next = { ...this.rawUsage };
    if ((incoming.service_tier !== undefined && incoming.service_tier !== "standard") ||
      (incoming.inference_geo !== undefined && incoming.inference_geo !== "global") ||
      (incoming.speed !== undefined && incoming.speed !== "standard")) fail("unsupported_capability");
    if (incoming.server_tool_use !== undefined && Object.values(object(incoming.server_tool_use)).some((count) => count !== 0)) fail("unsupported_capability");
    if (incoming.iterations !== undefined && (!Array.isArray(incoming.iterations) || incoming.iterations.length > 1)) fail("unsupported_capability");
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "total_input_tokens", "total_tokens"]) {
      if (incoming[key] === undefined) continue;
      const count = incoming[key];
      if (!Number.isSafeInteger(count) || Number(count) < Number(next[key] ?? 0)) fail("invalid_response");
      next[key] = count;
    }
    if (incoming.cache_creation !== undefined) {
      const creation = object(incoming.cache_creation), prior = next.cache_creation === undefined ? {} : object(next.cache_creation);
      const merged = { ...prior };
      for (const key of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) {
        if (creation[key] === undefined) continue;
        if (!Number.isSafeInteger(creation[key]) || Number(creation[key]) < Number(prior[key] ?? 0)) fail("invalid_response");
        merged[key] = creation[key];
      }
      next.cache_creation = merged;
    }
    if (incoming.output_tokens_details !== undefined) {
      const details = object(incoming.output_tokens_details);
      const prior = next.output_tokens_details === undefined ? {} : object(next.output_tokens_details);
      if (details.thinking_tokens !== undefined && (!Number.isSafeInteger(details.thinking_tokens) ||
          Number(details.thinking_tokens) < Number(prior.thinking_tokens ?? 0))) fail("invalid_response");
      next.output_tokens_details = { ...prior, ...details };
    }
    try { this.usage = normalizeUsage(this.request.modelId, next, { at: this.at, cacheTtl: this.request.cacheTtl }); }
    catch { fail("invalid_response"); }
    this.rawUsage = next;
  }
  emitText(text: unknown) {
    if (typeof text !== "string") fail("invalid_response");
    this.textBytes += bytes(text as string);
    if (this.textBytes > ANTHROPIC_LIMITS.textBytes) fail("response_limit");
    if (text) { try { this.onText?.(text as string); } catch { fail("consumer_error"); } }
  }
  event(value: unknown) {
    const event = object(value), type = event.type;
    if (type === "error") {
      const errorType = object(event.error).type;
      fail(errorType === "overloaded_error" || errorType === "rate_limit_error" ? "provider_busy" : "provider_error");
    }
    if (type === "ping" || !["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(String(type))) return;
    if (this.stopped) fail("invalid_response");
    if (type === "message_start") {
      if (this.started) fail("invalid_response");
      const message = object(event.message);
      if (message.model !== this.request.modelId) fail("model_mismatch");
      if ((message.service_tier !== undefined && message.service_tier !== "standard") ||
        (message.inference_geo !== undefined && message.inference_geo !== "global") ||
        (message.speed !== undefined && message.speed !== "standard")) fail("unsupported_capability");
      if (message.type !== "message" || message.role !== "assistant" || !id.safeParse(message.id).success ||
        !Array.isArray(message.content) || message.content.length || message.stop_reason !== null) fail("invalid_response");
      this.mergeUsage(message.usage); this.messageId = message.id as string; this.started = true; return;
    }
    if (!this.started) fail("invalid_response");
    if (type === "content_block_start") {
      if (this.deltas || event.index !== this.blocks.length || this.blocks.length >= ANTHROPIC_LIMITS.blocks) fail("invalid_response");
      const block = object(event.content_block);
      if (block.type === "fallback") fail("model_mismatch");
      if (block.type === "text") {
        this.emitText(block.text); this.blocks.push({ type: "text", text: block.text as string, closed: false });
      } else if (block.type === "tool_use") {
        if (!id.safeParse(block.id).success || !name.safeParse(block.name).success || this.toolIds.has(String(block.id)) ||
          !this.request.tools?.some((tool) => tool.name === block.name)) fail("invalid_response");
        if (this.toolIds.size >= ANTHROPIC_LIMITS.toolCalls) fail("response_limit");
        const initial = object(block.input); checkedJson(initial, "invalid_response", ANTHROPIC_LIMITS.toolJsonBytes);
        this.toolIds.add(block.id as string);
        this.blocks.push({ type: "tool_use", id: block.id as string, name: block.name as string, initial, json: "", closed: false });
      } else if (block.type === "thinking") {
        if (block.thinking !== "" || typeof block.signature !== "string") fail("unsupported_capability");
        if (bytes(block.signature) > ANTHROPIC_LIMITS.toolJsonBytes) fail("response_limit");
        this.blocks.push({ type: "thinking", signature: block.signature, closed: false });
      } else if (block.type === "redacted_thinking") {
        if (!opaque.safeParse(block.data).success) fail("invalid_response");
        this.blocks.push({ type: "redacted_thinking", data: block.data as string, closed: false });
      } else fail("unsupported_capability");
      return;
    }
    if (type === "content_block_delta" || type === "content_block_stop") {
      if (!Number.isSafeInteger(event.index)) fail("invalid_response");
      const block = this.blocks[event.index as number];
      if (!block || block.closed || this.deltas) fail("invalid_response");
      if (type === "content_block_stop") { block.closed = true; return; }
      const delta = object(event.delta);
      if (block.type === "text" && delta.type === "text_delta") { this.emitText(delta.text); block.text += delta.text as string; }
      else if (block.type === "tool_use" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        if (Object.keys(block.initial).length) fail("invalid_response");
        block.json += delta.partial_json;
        if (bytes(block.json) > ANTHROPIC_LIMITS.toolJsonBytes) fail("response_limit");
      } else if (block.type === "thinking" && delta.type === "thinking_delta" && delta.thinking === "") {
        // Omitted display: preserve the signature, never emit or retain readable reasoning.
      } else if (block.type === "thinking" && delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature += delta.signature;
        if (bytes(block.signature) > ANTHROPIC_LIMITS.toolJsonBytes) fail("response_limit");
      } else fail("unsupported_capability");
      return;
    }
    if (this.blocks.some((block) => !block.closed)) fail("invalid_response");
    if (type === "message_delta") {
      const delta = object(event.delta);
      if (delta.model !== undefined && delta.model !== this.request.modelId) fail("model_mismatch");
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
        if (!stopReasons.includes(String(delta.stop_reason))) fail("unsupported_capability");
        if (this.stopReason && this.stopReason !== delta.stop_reason) fail("invalid_response");
        this.stopReason = delta.stop_reason as AnthropicStopReason;
        // Initial output counts cannot stand in for a missing final cumulative report.
        if (event.usage === undefined || object(event.usage).output_tokens === undefined) fail("invalid_response");
      }
      if (event.usage !== undefined) this.mergeUsage(event.usage);
      this.deltas++; return;
    }
    if (!this.deltas || !this.stopReason || !this.usage) fail("incomplete_stream");
    this.stopped = true; this.usageComplete = true;
  }
  result(): Omit<Extract<AnthropicResult, { status: "completed" }>, "evidence" | "providerCostNanoUsd"> {
    if (!this.stopped || !this.usage || !this.stopReason) return fail("incomplete_stream");
    if (this.usage.totalInputTokens > this.request.maxInputTokens || this.usage.outputTokens > this.request.maxTokens ||
        this.usage.totalInputTokens + this.usage.outputTokens > NATIVE_INPUT_CAPACITY[this.request.modelId]!) fail("invalid_response");
    const truncated = this.stopReason === "max_tokens" || this.stopReason === "model_context_window_exceeded";
    const toolCalls: ToolCall[] = [];
    if (this.stopReason === "tool_use") {
      for (const block of this.blocks) if (block.type === "tool_use") {
        let input: Record<string, unknown>;
        try { input = block.json ? object(JSON.parse(block.json)) : block.initial; } catch { fail("invalid_response"); }
        checkedJson(input!, "invalid_response", ANTHROPIC_LIMITS.toolJsonBytes);
        toolCalls.push({ id: block.id, name: block.name, input: input! as Record<string, JsonValue> });
      }
      if (!toolCalls.length) fail("invalid_response");
    } else if (!truncated && this.toolIds.size) fail("invalid_response");
    const native: AnthropicOutputBlock[] = [];
    if (!truncated) for (const block of this.blocks) {
      if (block.type === "text") native.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        const tool = toolCalls.find((tool) => tool.id === block.id)!;
        native.push({ type: "tool_use", ...tool });
      } else if (block.type === "thinking") {
        if (!block.signature) fail("invalid_response");
        native.push({ type: "thinking", thinking: "", signature: block.signature });
      } else native.push({ type: "redacted_thinking", data: block.data });
    }
    return { status: "completed", modelId: this.request.modelId, messageId: this.messageId,
      text: this.blocks.filter((block): block is Extract<Block, { type: "text" }> => block.type === "text").map((block) => block.text).join(""),
      toolCalls, stopReason: this.stopReason, truncated, usage: this.usage, usageComplete: true,
      continuation: truncated || !native.length ? null : { provider: "anthropic", modelId: this.request.modelId, prefixHash: this.prefix, content: native } };
  }
}

type Read = () => Promise<ReadableStreamReadResult<Uint8Array>>;
async function consumeStream(read: Read, state: MessageState) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", eventName = "", data: string[] = [], eventBytes = 0, total = 0, events = 0;
  const line = (value: string) => {
    eventBytes += bytes(value) + 1;
    if (eventBytes > ANTHROPIC_LIMITS.eventBytes) fail("response_limit");
    if (!value) {
      if (data.length) {
        if (++events > ANTHROPIC_LIMITS.events) fail("response_limit");
        let parsed: Record<string, unknown>;
        try { parsed = object(JSON.parse(data.join("\n"))); } catch { return fail("invalid_response"); }
        if (typeof parsed.type !== "string" || (eventName && eventName !== parsed.type)) fail("invalid_response");
        state.event(parsed);
      }
      eventName = ""; data = []; eventBytes = 0; return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "event") eventName = content; else if (field === "data") data.push(content);
  };
  const drain = (final = false) => {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (!final && match[0] === "\r" && match.index === buffer.length - 1)) break;
      const current = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); line(current);
      if (state.stopped) break;
    }
    if (!state.stopped && bytes(buffer) + eventBytes > ANTHROPIC_LIMITS.eventBytes) fail("response_limit");
  };
  while (!state.stopped) {
    const chunk = await read();
    if (chunk.done) {
      try { buffer += decoder.decode(); } catch { fail("invalid_response"); }
      drain(true); break;
    }
    total += chunk.value.byteLength;
    if (total > ANTHROPIC_LIMITS.responseBytes) fail("response_limit");
    try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { fail("invalid_response"); }
    drain();
  }
  if (!state.stopped) fail("incomplete_stream");
}
async function consumeJson(read: Read, state: MessageState) {
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const chunk = await read(); if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > ANTHROPIC_LIMITS.responseBytes) fail("response_limit");
    chunks.push(chunk.value);
  }
  let message: Record<string, unknown>;
  try { message = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { return fail("invalid_response"); }
  if (!Array.isArray(message.content)) fail("invalid_response");
  const content = message.content as unknown[];
  state.event({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
  for (let index = 0; index < content.length; index++) {
    state.event({ type: "content_block_start", index, content_block: content[index] });
    state.event({ type: "content_block_stop", index });
  }
  state.event({ type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage });
  state.event({ type: "message_stop" });
}

/** Single HTTP attempt, disabled by default. No model fallback, paid retry, SDK or tool execution. */
export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}) {
  if (typeof window !== "undefined") throw new Error("Anthropic adapter is server-only.");
  const enabled = options.executionEnabled === true;
  const fetcher = options.fetch ?? globalThis.fetch;
  const getKey = options.getApiKey ?? (() => env.ANTHROPIC_API_KEY);
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid adapter timeout.");
  return Object.freeze({ async complete(request: AnthropicRequest, callOptions: AnthropicCallOptions = {}): Promise<AnthropicResult> {
    let submitted = false, state: MessageState | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let phase: ProviderFailurePhase = "pre_dispatch";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interruption: "cancelled" | "timeout" | undefined;
    const controller = new AbortController();
    const interrupt = (code: "cancelled" | "timeout") => { if (!controller.signal.aborted) { interruption = code; controller.abort(); } };
    const cancel = () => interrupt("cancelled");
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Fault(interruption ?? "cancelled")), { once: true }));
    // The cancellation promise can reject during cleanup after the last awaited operation.
    void aborted.catch(() => {});
    try {
      if (!enabled) fail("execution_disabled");
      const compiled = compileAnthropicRequest(request), body = compiled.body;
      const snapshot = JSON.parse(JSON.stringify(request)) as AnthropicRequest;
      if (callOptions.binding && (callOptions.binding.expectedRequestHash !== compiled.requestHash ||
          !canonicalTime(callOptions.binding.submittedAt))) fail("invalid_request");
      const apiKey = getKey()?.trim();
      if (!apiKey || /\s/.test(apiKey) || apiKey.length > 1024) fail("missing_key");
      const at = callOptions.binding?.submittedAt ?? now(); if (!canonicalTime(at)) fail("invalid_request");
      if (callOptions.signal?.aborted) fail("cancelled");
      callOptions.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => interrupt("timeout"), timeoutMs);
      state = new MessageState(snapshot, at, prefixHash(body.model, body.system, body.tools, snapshot.cacheTtl, body.messages), (text) => {
        const previousPhase = phase;
        if (callOptions.onText) { phase = "response_consumer"; callOptions.onText(text); }
        if (controller.signal.aborted) fail(interruption ?? "cancelled");
        phase = previousPhase;
      });
      submitted = true;
      phase = "fetch";
      const response = await Promise.race([fetcher(ANTHROPIC_ENDPOINT, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}`, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json",
          Accept: body.stream ? "text/event-stream" : "application/json" }, body: compiled.json, signal: controller.signal }), aborted]);
      phase = "response_headers";
      if (!response.ok) fail([401, 403, 402].includes(response.status) ? "provider_unavailable" : [429, 529].includes(response.status) ? "provider_busy" : "provider_error");
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith(body.stream ? "text/event-stream" : "application/json")) fail("invalid_response");
      reader = response.body.getReader();
      const read: Read = async () => {
        if (controller.signal.aborted) fail(interruption ?? "cancelled");
        phase = "response_body";
        const chunk = await Promise.race([reader!.read(), aborted]);
        phase = "response_validation";
        return chunk;
      };
      if (body.stream) await consumeStream(read, state); else await consumeJson(read, state);
      if (controller.signal.aborted) fail(interruption ?? "cancelled");
      const result = state.result();
      return { ...result, providerCostNanoUsd: costUsage(result.usage), evidence: {
        provider: "anthropic", adapterVersion: ANTHROPIC_ADAPTER_VERSION, requestFormatVersion: ANTHROPIC_REQUEST_FORMAT,
        requestHash: compiled.requestHash, submittedAt: at, reportedModelId: snapshot.modelId,
        providerMessageId: result.messageId, pricingProfile: "standard-global-text-v1", terminalEvent: "completed",
      } };
    } catch (error) {
      const code = interruption ?? (error instanceof Fault ? error.code : "network_error");
      return { status: "failed", code, message: messages[code], submission: submitted ? "uncertain" : "not_submitted",
        usage: state?.usage ?? null, usageComplete: state?.usageComplete ?? false,
        diagnostic: providerFailureDiagnostic(error, phase, code) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callOptions.signal?.removeEventListener("abort", cancel);
      if (reader) void reader.cancel().catch(() => {});
      // Abort even a fetch implementation which ignores cancellation races; never log its error.
      controller.abort();
    }
  } });
}
