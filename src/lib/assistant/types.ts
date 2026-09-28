import type OpenAI from "openai";
import type { ChartSpec } from "@/lib/charts/spec";
import type { ProjectBrief } from "../projects/store.ts";

export type SavedPlanCard = { id: string; projectId: string; title: string; kind: "thumbnail" | "ui"; conceptCount: number };

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
  | { type: "tool_start"; id: string; label: string; activity: string; detail: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary: string; result: unknown; ms: number }
  | { type: "chart"; id: string; chart: ChartSpec }
  | { type: "asset_plan"; plan: SavedPlanCard }
  | { type: "project_context"; project: ProjectBrief }
  | { type: "done"; messages: ApiMessage[] }
  /** Legacy event: ignored by clients and persistence; no longer generated. */
  | { type: "suggestion"; text: string }
  /** Sent last: what the answer cost, in credits (usually a fraction of one). */
  | { type: "usage"; credits: number }
  | { type: "error"; message: string };
