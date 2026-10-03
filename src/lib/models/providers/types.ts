import type { CapabilityRequirements, ModelId, NormalizedUsage, ProviderId } from "../types.ts";

/** Attributable final protocol evidence, not a ledger receipt or permission to execute tools. */
export type AdapterEvidence = {
  provider: ProviderId; adapterVersion: string; requestFormatVersion: string; requestHash: string;
  submittedAt: string; reportedModelId: string; providerMessageId: string;
  pricingProfile: "standard-global-text-v1"; terminalEvent: "completed";
};
export type AttemptBinding = { expectedRequestHash: string; submittedAt: string };

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
      continuation: AnthropicContinuation | null; evidence: AdapterEvidence; providerCostNanoUsd: number }
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
  /** Trusted durable dispatch timestamp/hash; a binding alone grants no authorization. */
  binding?: AttemptBinding;
  /** Provisional text only; tool calls are returned after the complete message is validated. */
  onText?: (delta: string) => void;
};

export type OpenAIModelId = Extract<ModelId, `gpt-${string}`>;
export type OpenAIOutputItem = Record<string, JsonValue>;
export type OpenAIContinuation = {
  provider: "openai"; modelId: OpenAIModelId; prefixHash: string; content: OpenAIOutputItem[];
};
export type OpenAIMessage = Extract<ProviderMessage, { role: "user" | "tool" }>
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[]; continuation?: OpenAIContinuation };
export type OpenAIRequest = {
  modelId: OpenAIModelId; system?: string; messages: readonly OpenAIMessage[]; tools?: readonly ProviderTool[];
  maxTokens: number; maxInputTokens: number; cacheTtl?: "30m";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  capabilities?: CapabilityRequirements;
};
export type OpenAIResult =
  | { status: "completed"; modelId: OpenAIModelId; messageId: string; text: string; toolCalls: ToolCall[];
      stopReason: "end_turn" | "tool_use" | "max_output_tokens" | "content_filter" | "refusal";
      truncated: boolean; usage: NormalizedUsage; usageComplete: true; continuation: OpenAIContinuation | null;
      evidence: AdapterEvidence; providerCostNanoUsd: number }
  | Extract<AnthropicResult, { status: "failed" }>;
export type OpenAIAdapterOptions = AnthropicAdapterOptions;
export type OpenAICallOptions = { signal?: AbortSignal; binding?: AttemptBinding };
