import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { env } from "node:process";
import { z } from "zod";
import { getModel } from "../catalog.ts";
import { costUsage, normalizeUsage } from "../usage.ts";
import type { NormalizedUsage } from "../types.ts";
import { canonicalTime, compileWire, safeJson } from "./wire.ts";
import type { AdapterErrorCode, JsonValue, OpenAIAdapterOptions, OpenAICallOptions, OpenAIOutputItem,
  OpenAIRequest, OpenAIResult, ToolCall } from "./types.ts";

export const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
export const OPENAI_ADAPTER_VERSION = "openai-responses-v1";
export const OPENAI_REQUEST_FORMAT = "openai-responses-json-v1";
export const OPENAI_LIMITS = Object.freeze({ requestBytes: 8 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  textBytes: 1024 * 1024, toolJsonBytes: 64 * 1024, toolCalls: 16, items: 128 });
class Fault extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode) { super(`Model request: ${code}.`); this.code = code; }
}
function fail(code: AdapterErrorCode): never { throw new Fault(code); }
const bytes = (value: string) => Buffer.byteLength(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_response");
  return value as Record<string, unknown>;
}
function json(value: unknown, code: AdapterErrorCode, limit: number): string {
  try { return safeJson(value, limit); } catch { return fail(code); }
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const jsonObject = z.record(z.string(), z.unknown());
const toolCall = z.object({ id, name, input: jsonObject }).strict();
const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal("image"), mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().min(4).max(7 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]);
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.union([z.string().min(1), z.array(part).min(1).max(64)]) }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(toolCall).max(OPENAI_LIMITS.toolCalls).optional(),
    continuation: z.object({ provider: z.literal("openai"), modelId: z.string(), prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
      content: z.array(jsonObject).min(1).max(OPENAI_LIMITS.items) }).strict().optional() }).strict(),
  z.object({ role: z.literal("tool"), toolCallId: id, content: z.string(), isError: z.boolean().optional() }).strict(),
]);
const requestSchema = z.object({ modelId: z.string(), system: z.string().optional(), messages: z.array(message).min(1).max(512),
  tools: z.array(z.object({ name, description: z.string().max(16_384), inputSchema: jsonObject }).strict()).max(64).optional(),
  maxTokens: z.number().int().min(1).max(16_000), maxInputTokens: z.number().int().min(1).max(200_000),
  cacheTtl: z.literal("30m").optional(), reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
  capabilities: z.object({ text: z.boolean().optional(), tools: z.boolean().optional(), images: z.boolean().optional() }).strict().optional(),
}).strict();
type WireItem = Record<string, unknown>;
export type OpenAIWireRequest = {
  model: string; input: WireItem[]; tools?: WireItem[]; instructions?: string; max_output_tokens: number;
  reasoning: { effort: string; context: "current_turn" }; prompt_cache_options: { mode: "implicit"; ttl: "30m" };
  store: false; stream: false; background: false; service_tier: "default"; parallel_tool_calls: false;
};
function prefixHash(body: Omit<OpenAIWireRequest, "input">, input: WireItem[]): string {
  return createHash("sha256").update(json({ ...body, input }, "invalid_request", OPENAI_LIMITS.requestBytes)).digest("hex");
}

/** Text/images and application function tools only. No hosted tools, remote assets or implicit model. */
export function translateOpenAIRequest(value: OpenAIRequest): OpenAIWireRequest {
  json(value, "invalid_request", OPENAI_LIMITS.requestBytes);
  const selected = getModel(value?.modelId);
  if (!selected || selected.provider !== "openai") fail("unsupported_model");
  if (value.capabilities && Object.keys(value.capabilities).some(key => !["text", "tools", "images"].includes(key))) fail("unsupported_capability");
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) fail("invalid_request");
  const request = parsed.data;
  if (request.maxInputTokens + request.maxTokens > selected.contextTokens || request.maxTokens > selected.maxOutputTokens ||
      (selected.id !== "gpt-6-luna" && request.reasoningEffort === "none")) fail("invalid_request");
  const tools = request.tools?.map(tool => {
    json(tool.inputSchema, "invalid_request", OPENAI_LIMITS.toolJsonBytes);
    if (tool.inputSchema.type !== "object") fail("invalid_request");
    return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false };
  });
  if (new Set(tools?.map(tool => tool.name)).size !== (tools?.length ?? 0)) fail("invalid_request");
  const base: Omit<OpenAIWireRequest, "input"> = {
    model: selected.id, max_output_tokens: request.maxTokens, reasoning: { effort: request.reasoningEffort ?? "medium", context: "current_turn" },
    prompt_cache_options: { mode: "implicit", ttl: "30m" }, store: false, stream: false, background: false,
    service_tier: "default", parallel_tool_calls: false,
    ...(request.system ? { instructions: request.system } : {}), ...(tools?.length ? { tools } : {}),
  };
  const input: WireItem[] = [], seen = new Set<string>();
  let pending = new Set<string>();
  for (const entry of request.messages) {
    if (entry.role === "tool") {
      if (!pending.delete(entry.toolCallId)) fail("invalid_request");
      input.push({ type: "function_call_output", call_id: entry.toolCallId, output: entry.content });
      continue;
    }
    if (pending.size) fail("invalid_request");
    if (entry.role === "user") {
      input.push({ role: "user", content: typeof entry.content === "string" ? entry.content : entry.content.map(block =>
        block.type === "text" ? { type: "input_text", text: block.text } : {
          type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}`, detail: "auto",
        }) });
      continue;
    }
    const calls = entry.toolCalls ?? [];
    pending = new Set(calls.map(call => call.id));
    if (pending.size !== calls.length || calls.some(call => seen.has(call.id) || !request.tools?.some(tool => tool.name === call.name))) fail("invalid_request");
    calls.forEach(call => seen.add(call.id));
    if (entry.continuation) {
      const native = entry.continuation;
      if (native.modelId !== selected.id || native.prefixHash !== prefixHash(base, input)) fail("invalid_request");
      const validated = output(native.content, request.tools ?? [], false);
      if (validated.refused || validated.text !== entry.content || JSON.stringify(validated.toolCalls) !== JSON.stringify(calls)) fail("invalid_request");
      input.push(...native.content);
    } else {
      // A reasoning tool round must replay the opaque native items as well as visible text/calls.
      if (calls.length) fail("invalid_request");
      if (!entry.content) fail("invalid_request");
      input.push({ role: "assistant", content: entry.content });
    }
  }
  if (pending.size || request.messages[0].role !== "user" || request.messages.at(-1)?.role === "assistant") fail("invalid_request");
  const body = { ...base, input };
  json(body, "invalid_request", OPENAI_LIMITS.requestBytes);
  return body;
}
export function compileOpenAIRequest(request: OpenAIRequest) {
  return compileWire(translateOpenAIRequest(request), { endpoint: OPENAI_ENDPOINT, requestFormat: OPENAI_REQUEST_FORMAT }, OPENAI_LIMITS.requestBytes);
}

function output(value: unknown, tools: readonly { name: string }[], truncated: boolean) {
  if (!Array.isArray(value) || value.length > OPENAI_LIMITS.items) fail("invalid_response");
  const native: OpenAIOutputItem[] = [], toolCalls: ToolCall[] = [], ids = new Set<string>(), callIds = new Set<string>();
  let text = "", refused = false;
  for (const item of value as unknown[]) {
    const block = object(item);
    if (!id.safeParse(block.id).success || ids.has(String(block.id))) fail("invalid_response");
    ids.add(block.id as string);
    if (block.status !== undefined && (truncated ? !["completed", "incomplete"].includes(String(block.status)) : block.status !== "completed")) fail("invalid_response");
    if (block.type === "message") {
      if (block.role !== "assistant" || !Array.isArray(block.content) || block.status === undefined ||
          (block.phase != null && !["commentary", "final_answer"].includes(String(block.phase)))) fail("invalid_response");
      for (const raw of block.content as unknown[]) {
        const part = object(raw);
        if (part.type === "output_text" && typeof part.text === "string") {
          if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length > 0)) fail("unsupported_capability");
          text += part.text;
        } else if (part.type === "refusal" && typeof part.refusal === "string") { text += part.refusal; refused = true; }
        else fail("unsupported_capability");
        if (bytes(text) > OPENAI_LIMITS.textBytes) fail("response_limit");
      }
    } else if (block.type === "function_call") {
      if (!id.safeParse(block.call_id).success || callIds.has(String(block.call_id)) || !name.safeParse(block.name).success ||
          !tools.some(tool => tool.name === block.name) || typeof block.arguments !== "string" || block.status === undefined) fail("invalid_response");
      if (bytes(block.arguments as string) > OPENAI_LIMITS.toolJsonBytes || callIds.size >= OPENAI_LIMITS.toolCalls) fail("response_limit");
      callIds.add(block.call_id as string);
      if (!truncated) {
        let input: Record<string, unknown>;
        try { input = object(JSON.parse(block.arguments as string)); } catch { return fail("invalid_response"); }
        json(input, "invalid_response", OPENAI_LIMITS.toolJsonBytes);
        toolCalls.push({ id: block.call_id as string, name: block.name as string, input: input as Record<string, JsonValue> });
      }
    } else if (block.type === "reasoning") {
      if (!Array.isArray(block.summary) || block.summary.length || block.content !== undefined && (!Array.isArray(block.content) || block.content.length)) fail("unsupported_capability");
      if (!truncated && (typeof block.encrypted_content !== "string" || !block.encrypted_content)) fail("invalid_response");
      if (typeof block.encrypted_content === "string" && bytes(block.encrypted_content) > OPENAI_LIMITS.responseBytes) fail("response_limit");
    } else fail("unsupported_capability"); // Hosted tools can incur unquoted charges.
    json(block, "invalid_response", OPENAI_LIMITS.responseBytes);
    native.push(block as OpenAIOutputItem);
  }
  if (refused && callIds.size) fail("invalid_response");
  return { text, refused, toolCalls, native };
}

/** Derived from the local OpenAI draft's single-call, bounded deadline/store:false transport.
 * Uses Responses for reasoning tools; no SDK retries, redirect, fallback, or tool execution. */
export function createOpenAIAdapter(options: OpenAIAdapterOptions = {}) {
  if (typeof window !== "undefined") throw new Error("OpenAI adapter is server-only.");
  const enabled = options.executionEnabled === true, fetcher = options.fetch ?? globalThis.fetch;
  const getKey = options.getApiKey ?? (() => env.OPENAI_API_KEY), now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid adapter timeout.");
  return Object.freeze({ async complete(request: OpenAIRequest, callOptions: OpenAICallOptions = {}): Promise<OpenAIResult> {
    let submitted = false, usage: NormalizedUsage | null = null, usageComplete = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let interruption: "cancelled" | "timeout" | undefined;
    const controller = new AbortController();
    const interrupt = (code: "cancelled" | "timeout") => { if (!controller.signal.aborted) { interruption = code; controller.abort(); } };
    const cancel = () => interrupt("cancelled");
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Fault(interruption ?? "cancelled")), { once: true }));
    void aborted.catch(() => {});
    try {
      if (!enabled) fail("execution_disabled");
      const compiled = compileOpenAIRequest(request), body = compiled.body;
      const snapshot = JSON.parse(json(request, "invalid_request", OPENAI_LIMITS.requestBytes)) as OpenAIRequest;
      if (callOptions.binding && (callOptions.binding.expectedRequestHash !== compiled.requestHash || !canonicalTime(callOptions.binding.submittedAt))) fail("invalid_request");
      const apiKey = getKey()?.trim();
      if (!apiKey || /\s/.test(apiKey) || apiKey.length > 1024) fail("missing_key");
      const at = callOptions.binding?.submittedAt ?? now();
      if (!canonicalTime(at)) fail("invalid_request");
      if (callOptions.signal?.aborted) fail("cancelled");
      callOptions.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => interrupt("timeout"), timeoutMs);
      submitted = true;
      const response = await Promise.race([fetcher(OPENAI_ENDPOINT, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: compiled.json, signal: controller.signal }), aborted]);
      if (!response.ok) fail([401, 402, 403].includes(response.status) ? "provider_unavailable" : response.status === 429 ? "provider_busy" : "provider_error");
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail("invalid_response");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      for (;;) {
        if (controller.signal.aborted) fail(interruption ?? "cancelled");
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > OPENAI_LIMITS.responseBytes) fail("response_limit");
        chunks.push(chunk.value);
      }
      if (controller.signal.aborted) fail(interruption ?? "cancelled");
      let envelope: Record<string, unknown>;
      try { envelope = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { return fail("invalid_response"); }
      if (envelope.object !== "response" || !id.safeParse(envelope.id).success) fail("invalid_response");
      if (envelope.model !== snapshot.modelId) fail("model_mismatch");
      if (envelope.service_tier !== "default" || envelope.store !== false || envelope.background === true ||
          (envelope.inference_geo !== undefined && envelope.inference_geo !== "global") ||
          (envelope.tools !== undefined && (!Array.isArray(envelope.tools) || envelope.tools.some(raw => object(raw).type !== "function")))) fail("unsupported_capability");
      if (!["completed", "incomplete"].includes(String(envelope.status)) || envelope.error != null) fail("invalid_response");
      const truncated = envelope.status === "incomplete";
      const incompleteReason = truncated ? object(envelope.incomplete_details).reason : null;
      if (truncated ? !["max_output_tokens", "content_filter"].includes(String(incompleteReason)) : envelope.incomplete_details != null) fail("invalid_response");
      const rawUsage = object(envelope.usage);
      if (rawUsage.input_tokens_details === undefined || rawUsage.output_tokens_details === undefined || rawUsage.total_tokens === undefined) fail("invalid_response");
      const details = object(rawUsage.input_tokens_details);
      if (details.cached_tokens === undefined || details.cache_write_tokens === undefined) fail("invalid_response");
      try { usage = normalizeUsage(snapshot.modelId, rawUsage, { at, cacheTtl: "30m" }); } catch { fail("invalid_response"); }
      usageComplete = true; // Complete counters still do not prove semantic validity or authorize settlement.
      if (usage!.totalInputTokens > snapshot.maxInputTokens || usage!.outputTokens > snapshot.maxTokens) fail("invalid_response");
      const parsed = output(envelope.output, snapshot.tools ?? [], truncated);
      const { input, ...base } = body;
      return { status: "completed", modelId: snapshot.modelId, messageId: envelope.id as string, text: parsed.text,
        toolCalls: parsed.toolCalls, stopReason: truncated ? incompleteReason as "max_output_tokens" | "content_filter" : parsed.refused ? "refusal" : parsed.toolCalls.length ? "tool_use" : "end_turn",
        truncated, usage: usage!, usageComplete: true, providerCostNanoUsd: costUsage(usage!),
        continuation: truncated || parsed.refused || !parsed.native.length ? null : {
          provider: "openai", modelId: snapshot.modelId, prefixHash: prefixHash(base, input), content: parsed.native,
        }, evidence: { provider: "openai", adapterVersion: OPENAI_ADAPTER_VERSION, requestFormatVersion: OPENAI_REQUEST_FORMAT,
          requestHash: compiled.requestHash, submittedAt: at, reportedModelId: envelope.model as string,
          providerMessageId: envelope.id as string, pricingProfile: "standard-global-text-v1", terminalEvent: "completed" } };
    } catch (error) {
      const code = interruption ?? (error instanceof Fault ? error.code : "network_error");
      return { status: "failed", code, message: `Model request: ${code}.`, submission: submitted ? "uncertain" : "not_submitted", usage, usageComplete };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callOptions.signal?.removeEventListener("abort", cancel);
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
    }
  } });
}
