import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompt";
import { FetchedData } from "./fetched-data";
import { suggestFollowUp } from "./follow-up";
import { prepareCall, runTool, TOOLS } from "./tools";
import type { ApiMessage, AssistantEvent } from "./types";

// The assistant's model loop, shared by Ask Romanum (/api/assistant) and saved chats (/api/chats).

// DeepSeek speaks the OpenAI chat-completions protocol.
const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";
const MAX_TOKENS = 16000;
/** Model calls per user message, so a confused tool loop can't run up the bill. */
const MAX_STEPS = 8;

type DeepSeekDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null };

export const assistantClient = (apiKey: string) => new OpenAI({ apiKey, baseURL: BASE_URL });

function describeError(error: unknown): string {
  // Provider setup and billing diagnostics belong in server logs and README.md.
  if (error instanceof OpenAI.AuthenticationError || (error instanceof OpenAI.APIError && error.status === 402)) return "Assistant unavailable. Try again later.";
  if (error instanceof OpenAI.RateLimitError) return "Assistant busy. Try again shortly.";
  return "Couldn't get a response. Try again.";
}

/**
 * Answers the last question in `conversation`, streaming each step through `send`. It ends with a "done" event
 * holding the turn's model messages (then possibly a suggestion), or with an "error" event. It never throws.
 */
export async function runAssistant({
  client,
  conversation,
  send,
  signal,
  systemPrompt = SYSTEM_PROMPT,
}: {
  client: OpenAI;
  conversation: ApiMessage[];
  send: (event: AssistantEvent) => void;
  signal: AbortSignal;
  systemPrompt?: string;
}): Promise<void> {
  // Everything the model and tools add during this turn, returned so the conversation can continue from it.
  const turn: ApiMessage[] = [];
  // What the tools have fetched so far in the conversation; charts can only plot these values.
  const fetched = FetchedData.fromMessages(conversation);

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await client.chat.completions.create(
        {
          model: MODEL,
          messages: [{ role: "system", content: systemPrompt }, ...conversation, ...turn],
          tools: TOOLS,
          max_tokens: MAX_TOKENS,
          stream: true,
        },
        { signal },
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
        // The answer is complete above; the suggestion follows on the same stream when it's ready.
        const question = conversation.at(-1)?.content;
        const suggestion = await suggestFollowUp(client, MODEL, typeof question === "string" ? question : "", content, signal);
        if (suggestion) send({ type: "suggestion", text: suggestion });
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
        const outcome = await runTool(prepared, fetched);
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
        return {
          role: "tool" as const,
          tool_call_id: call.id,
          content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
        };
      };

      // Lookups run in parallel; charts run after them, so a chart requested alongside a lookup sees its data.
      const lookups = toolCalls.filter((call) => call.name !== "create_chart");
      const charts = toolCalls.filter((call) => call.name === "create_chart");
      const results = new Map<string, ApiMessage>();
      for (const message of await Promise.all(lookups.map(execute))) results.set(message.tool_call_id, message);
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
