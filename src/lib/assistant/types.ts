import type OpenAI from "openai";

/** DeepSeek returns its reasoning alongside the reply and needs it sent back on later requests. */
export type AssistantApiMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/** Conversation history in the chat-completions format, as sent to /api/assistant. */
export type ApiMessage =
  | OpenAI.Chat.ChatCompletionUserMessageParam
  | AssistantApiMessage
  | OpenAI.Chat.ChatCompletionToolMessageParam;

/** One line of the NDJSON stream returned by /api/assistant. */
export type AssistantEvent =
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; label: string; detail: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary: string; result: unknown; ms: number }
  | { type: "done"; messages: ApiMessage[] }
  | { type: "error"; message: string };
