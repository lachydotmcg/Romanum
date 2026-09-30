import type OpenAI from "openai";
import { assistantClient, runAssistant } from "@/lib/assistant/engine";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { welcomeGuest } from "@/lib/credits/guest";
import { welcomeAccount } from "@/lib/credits/account";
import { assistantBilling } from "@/lib/assistant/billing";
import { ensureOwner, readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase, type Database } from "@/lib/history/database";
import { verificationResponse } from "@/lib/turnstile";
import { privateAnalyticsTools } from "@/lib/linked-games/assistant-tools";
import { usesBackgroundChatWorker } from "@/lib/chats/run-dispatch";

const MAX_MESSAGES = 80;
const MAX_USER_CHARS = 4000;
const MAX_BODY_CHARS = 500_000;

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

export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403 });
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

  // Answers spend credits, so the owner needs some before the model is called.
  let db: Database;
  let owner: string;
  let accountId: string | undefined;
  try {
    const database = await historyDatabase();
    if (!database) throw new Error("No database is configured.");
    db = database;
    owner = await ensureOwner(request);
    const account = await readAccount();
    if (account?.ownerId === owner) accountId = account.id;
    const balance = account?.ownerId === owner ? await welcomeAccount(db, account.id) : await welcomeGuest(db, owner);
    if (balance.available < 1) return Response.json({ error: "You're out of credits." }, { status: 402 });
  } catch (error) {
    const verification = verificationResponse(error);
    if (verification) return verification;
    return Response.json({ error: "Credits unavailable. Try again later." }, { status: 503 });
  }

  const client = assistantClient(apiKey);
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AssistantEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const billing = assistantBilling(db, owner, "ask");
      try {
        const timeBudget = usesBackgroundChatWorker() ? 25_000 : undefined;
        const analyticsTools = accountId ? privateAnalyticsTools(db, accountId, abort.signal, timeBudget ? { signal: AbortSignal.timeout(timeBudget) } : {}) : undefined;
        await runAssistant({ client, conversation, send, signal: abort.signal, billing, analyticsTools, analysisTimeBudgetMs: timeBudget });
      } finally {
        if (billing.credits) send({ type: "usage", credits: billing.credits });
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
