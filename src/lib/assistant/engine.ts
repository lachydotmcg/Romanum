import OpenAI from "openai";
import type { CallUsage } from "@/lib/credits/pricing";
import { CreditsError } from "../credits/ledger.ts";
import { meteredStream, reportedCallUsage, type AssistantBilling } from "./billing.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { FetchedData } from "./fetched-data.ts";
import { prepareCall, runTool, TOOLS } from "./tools.ts";
import type { ApiMessage, AssistantEvent } from "./types";
import type { ProjectChatTools } from "../projects/chat-tools";

// The assistant's model loop, shared by Ask Romanum (/api/assistant) and saved chats (/api/chats).

// DeepSeek speaks the OpenAI chat-completions protocol.
const BASE_URL = "https://api.deepseek.com";
export const ASSISTANT_MODEL = "deepseek-flash";
const MAX_TOKENS = 16000;
/** Model calls per user message, so a confused tool loop can't run up the bill. */
const MAX_STEPS = 8;

type DeepSeekDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null };
/** DeepSeek splits input into cache hits and misses as well as the standard fields. */
type DeepSeekUsage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };

export const assistantClient = (apiKey: string) => new OpenAI({ apiKey, baseURL: BASE_URL, maxRetries: 0 });

/** A DeepSeek call's token counts in pricing terms: uncached input, cached input and output. */
export function callUsage(at: Date, usage: DeepSeekUsage): CallUsage {
  return reportedCallUsage(at, usage);
}

function describeError(error: unknown): string {
  if (error instanceof CreditsError && error.code === "insufficient_balance") return "Not enough credits for the next step.";
  // Provider setup and billing diagnostics belong in server logs and README.md.
  if (error instanceof OpenAI.AuthenticationError || (error instanceof OpenAI.APIError && error.status === 402)) return "Assistant unavailable. Try again later.";
  if (error instanceof OpenAI.RateLimitError) return "Assistant busy. Try again shortly.";
  return "Couldn't get a response. Try again.";
}

/**
 * Answers the last question in `conversation`, streaming each step through `send`. It ends with a "done" event
 * holding the turn's model messages, or with an "error" event. It never throws.
 * Each provider attempt reserves credits first and settles before the next step.
 */
export async function runAssistant({
  client,
  conversation,
  send,
  signal,
  billing,
  systemPrompt = SYSTEM_PROMPT,
  projectTools,
}: {
  client: OpenAI;
  conversation: ApiMessage[];
  send: (event: AssistantEvent) => void;
  signal: AbortSignal;
  billing: AssistantBilling;
  systemPrompt?: string;
  projectTools?: ProjectChatTools;
}): Promise<void> {
  // Everything the model and tools add during this turn, returned so the conversation can continue from it.
  const turn: ApiMessage[] = [];
  // What the tools have fetched so far in the conversation; charts can only plot these values.
  const fetched = FetchedData.fromMessages(conversation);

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = meteredStream(
        client,
        {
          model: ASSISTANT_MODEL,
          messages: [{ role: "system", content: systemPrompt }, ...conversation, ...turn],
          tools: [...TOOLS, ...(projectTools?.definitions ?? [])],
          max_tokens: MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        },
        billing,
        signal,
      );

      let content = "";
      let reasoning = "";
      const calls: { id: string; name: string; arguments: string }[] = [];

      for await (const chunk of completion) {
        const delta = chunk.choices[0]?.delta as DeepSeekDelta | undefined;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          send({ type: "thinking", delta: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          send({ type: "text", delta: delta.content });
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
        }
      }

      const toolCalls = calls.filter((call) => call && call.id && call.name);
      // DeepSeek requires reasoning_content on every assistant message it produced when tools are in use.
      turn.push({
        role: "assistant",
        content,
        reasoning_content: reasoning,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });

      if (!toolCalls.length) {
        send({ type: "done", messages: turn });
        return;
      }

      const execute = async (call: (typeof toolCalls)[number]) => {
        const prepared = prepareCall(call.name, call.arguments);
        send({
          type: "tool_start",
          id: call.id,
          label: prepared.label,
          activity: prepared.activity,
          detail: prepared.detail,
          input: prepared.args,
        });
        const started = Date.now();
        const privateCall = projectTools?.definitions.some((tool) => tool.function.name === call.name);
        const outcome = signal.aborted ? { ok: false as const, error: "Stopped." }
          : privateCall ? await projectTools!.execute(prepared, call.id)
          : await billing.tool(call.name, () => runTool(prepared, fetched), signal);
        if (outcome.ok) fetched.add(outcome.result);
        send({
          type: "tool_end",
          id: call.id,
          ok: outcome.ok,
          summary: outcome.ok ? outcome.summary : outcome.error,
          result: outcome.ok ? outcome.result : null,
          ms: Date.now() - started,
        });
        if (outcome.ok && outcome.chart) send({ type: "chart", id: call.id, chart: outcome.chart });
        if (outcome.ok && outcome.plan) send({ type: "asset_plan", plan: outcome.plan });
        if (outcome.ok && outcome.project) send({ type: "project_context", project: outcome.project });
        return {
          role: "tool" as const,
          tool_call_id: call.id,
          content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
        };
      };

      // Lookups run in parallel; charts run after them, so a chart requested alongside a lookup sees its data.
      const writes = toolCalls.filter((call) => call.name === "save_project_context" || call.name === "save_asset_plan");
      const lookups = toolCalls.filter((call) => call.name !== "create_chart" && !writes.includes(call));
      const charts = toolCalls.filter((call) => call.name === "create_chart");
      const results = new Map<string, ApiMessage>();
      // Let every started lookup settle before ending the stream on a billing failure.
      const lookupsFinished = await Promise.allSettled(lookups.map(execute));
      const failure = lookupsFinished.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const result of lookupsFinished) {
        if (result.status === "fulfilled") results.set(result.value.tool_call_id, result.value);
      }
      // Private mutations are ordered so a context save cannot race an asset plan.
      for (const call of writes) { const message = await execute(call); results.set(message.tool_call_id, message); }
      for (const call of charts) {
        const message = await execute(call);
        results.set(message.tool_call_id, message);
      }
      // Tool results go back in the order the model made the calls.
      turn.push(...toolCalls.map((call) => results.get(call.id)!));
    }

    send({ type: "error", message: `Stopped after ${MAX_STEPS} steps without a final answer.` });
    send({ type: "done", messages: turn });
  } catch (error) {
    if (!signal.aborted) {
      console.error("Assistant request failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        status: error instanceof OpenAI.APIError ? error.status : undefined,
      });
      send({ type: "error", message: describeError(error) });
    }
  }
}
