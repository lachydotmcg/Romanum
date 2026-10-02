import type { CapabilityRequirements, ModelId, NormalizedUsage } from "../types.ts";

export type AnthropicModelId = Extract<ModelId, `claude-${string}`>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ToolCall = { id: string; name: string; input: { [key: string]: JsonValue } };
export type AnthropicOutputBlock = { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { [key: string]: JsonValue } }
  | { type: "thinking"; thinking: ""; signature: string }
  | { type: "redacted_thinking"; data: string };
/** Trusted server history only: preserve opaque signatures and exact order, never display/log them. */
export type AnthropicContinuation = {
  provider: "anthropic"; modelId: AnthropicModelId; prefixHash: string; content: AnthropicOutputBlock[];
};
export type InputPart = { type: "text"; text: string } | {
  type: "image"; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string;
};
export type ProviderMessage =
  | { role: "user"; content: string | readonly InputPart[] }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[]; continuation?: AnthropicContinuation }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };
export type ProviderTool = { name: string; description: string; inputSchema: { [key: string]: JsonValue } };
export type AnthropicRequest = {
  modelId: AnthropicModelId; system?: string; messages: readonly ProviderMessage[];
  tools?: readonly ProviderTool[]; maxTokens: number;
  /** Trusted integration's conservative bound including tools, framing, history and vision. */
  maxInputTokens: number; stream?: boolean; cacheTtl?: "5m" | "1h";
  capabilities?: CapabilityRequirements;
};
export type AdapterErrorCode = "execution_disabled" | "missing_key" | "invalid_request" | "unsupported_capability"
  | "unsupported_model" | "cancelled" | "timeout" | "network_error" | "provider_unavailable" | "provider_busy"
  | "provider_error" | "invalid_response" | "model_mismatch" | "incomplete_stream" | "response_limit" | "consumer_error";
export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "model_context_window_exceeded" | "refusal";
export type AnthropicResult =
  | { status: "completed"; modelId: AnthropicModelId; messageId: string; text: string; toolCalls: ToolCall[];
      stopReason: AnthropicStopReason; truncated: boolean; usage: NormalizedUsage; usageComplete: true;
      continuation: AnthropicContinuation | null }
  | { status: "failed"; code: AdapterErrorCode; message: string;
      /** After submission, errors cannot prove that no bill was incurred. Never auto-release/retry. */
      submission: "not_submitted" | "uncertain"; usage: NormalizedUsage | null; usageComplete: boolean };
export type AnthropicAdapterOptions = {
  /** Off by default. Trusted review gate only; never take this from request JSON/environment flags. */
  executionEnabled?: boolean; fetch?: typeof globalThis.fetch; getApiKey?: () => string | undefined;
  timeoutMs?: number; now?: () => string;
};
export type AnthropicCallOptions = {
  signal?: AbortSignal;
  /** Provisional text only; tool calls are returned after the complete message is validated. */
  onText?: (delta: string) => void;
};
