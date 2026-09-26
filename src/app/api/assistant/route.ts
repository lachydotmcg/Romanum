import OpenAI from "openai";
import { SYSTEM_PROMPT } from "@/lib/assistant/prompt";
import { prepareCall, runTool, TOOLS } from "@/lib/assistant/tools";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";

// DeepSeek speaks the OpenAI chat-completions protocol.
const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";
const MAX_TOKENS = 16000;
/** Model calls per user message, so a confused tool loop can't run up the bill. */
const MAX_STEPS = 6;
const MAX_MESSAGES = 80;
const MAX_USER_CHARS = 4000;
const MAX_BODY_CHARS = 500_000;

type DeepSeekDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null };

function isToolCall(value: unknown): value is OpenAI.Chat.ChatCompletionMessageFunctionToolCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  const fn = call.function as Record<string, unknown> | undefined;
  return (
    typeof call.id === "string" &&
    call.type === "function" &&
    typeof fn?.name === "string" &&
    typeof fn?.arguments === "string"
  );
}

/** Accepts only the message shapes this route produces, ending with the new user message. */
function parseMessages(body: unknown): ApiMessage[] | null {
  const list = body && typeof body === "object" ? (body as { messages?: unknown }).messages : null;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null;

  const messages: ApiMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const msg = item as Record<string, unknown>;

    if (msg.role === "user") {
      if (typeof msg.content !== "string" || !msg.content.trim() || msg.content.length > MAX_USER_CHARS) return null;
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isToolCall) : [];
      messages.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
        ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === "tool") {
      if (typeof msg.tool_call_id !== "string" || typeof msg.content !== "string") return null;
      messages.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content });
    } else {
      return null;
    }
  }
  return messages.at(-1)?.role === "user" ? messages : null;
}

function describeError(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) return "DeepSeek rejected the API key. Check DEEPSEEK_API_KEY in .env.local.";
  if (error instanceof OpenAI.RateLimitError) return "DeepSeek's rate limit was reached. Try again in a moment.";
  if (error instanceof OpenAI.APIError && error.status === 402) return "The DeepSeek account has run out of credit.";
  if (error instanceof OpenAI.APIError) return `DeepSeek returned an error (${error.status ?? "no status"}): ${error.message}`;
  return error instanceof Error ? error.message : "The request failed.";
}

export async function POST(request: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ error: "The AI assistant isn't connected." }, { status: 503 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: "The conversation is too long." }, { status: 413 });
  let history: ApiMessage[] | null = null;
  try {
    history = parseMessages(JSON.parse(raw));
  } catch {
    // Handled below.
  }
  if (!history) return Response.json({ error: "Invalid conversation." }, { status: 400 });
  const conversation = history;

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AssistantEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      // Everything the model and tools add during this turn, returned so the client can send it back next time.
      const turn: ApiMessage[] = [];

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const completion = await client.chat.completions.create(
            {
              model: MODEL,
              messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversation, ...turn],
              tools: TOOLS,
              max_tokens: MAX_TOKENS,
              stream: true,
            },
            { signal: abort.signal },
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

          const results = await Promise.all(
            toolCalls.map(async (call) => {
              const prepared = prepareCall(call.name, call.arguments);
              send({ type: "tool_start", id: call.id, label: prepared.label, detail: prepared.detail, input: prepared.args });
              const started = Date.now();
              const outcome = await runTool(prepared);
              send({
                type: "tool_end",
                id: call.id,
                ok: outcome.ok,
                summary: outcome.ok ? outcome.summary : outcome.error,
                result: outcome.ok ? outcome.result : null,
                ms: Date.now() - started,
              });
              return {
                role: "tool" as const,
                tool_call_id: call.id,
                content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
              };
            }),
          );
          turn.push(...results);
        }

        send({ type: "error", message: `Stopped after ${MAX_STEPS} steps without a final answer.` });
        send({ type: "done", messages: turn });
      } catch (error) {
        if (!abort.signal.aborted) send({ type: "error", message: describeError(error) });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
