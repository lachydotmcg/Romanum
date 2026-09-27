import { assistantClient, runAssistant } from "@/lib/assistant/engine";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/lib/chats/limits";
import { CHAT_PROMPT } from "@/lib/chats/prompt";
import {
  ChatError,
  isChatId,
  listChats,
  modelConversation,
  questionForModel,
  recordEvent,
  saveAnswer,
  saveQuestion,
  type TimedEvent,
} from "@/lib/chats/store";
import { ensureGuest, isCrossSite, readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Room for a question, three attachments at the size limit and the form's own overhead. */
const MAX_BODY_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES + 64 * 1024;

const failure = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });

async function database() {
  try {
    return await historyDatabase();
  } catch {
    return null;
  }
}

/** The guest's chats, most recent first. */
export async function GET() {
  const owner = await readGuest();
  if (!owner) return Response.json({ chats: [] }, { headers: NO_STORE });
  const db = await database();
  if (!db) return failure(503, "Chats unavailable.");
  try {
    return Response.json({ chats: await listChats(db, owner) }, { headers: NO_STORE });
  } catch {
    return failure(503, "Chats unavailable.");
  }
}

/** Asks a question in a chat, starting one when no chatId is sent, and streams the answer as NDJSON. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return failure(403, "Request rejected.");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return failure(503, "The AI assistant isn't connected.");
  // The body is read whole, so its declared size is checked first; a missing size is refused too.
  if (!(Number(request.headers.get("content-length") ?? Number.NaN) <= MAX_BODY_BYTES)) {
    return failure(413, "Attach up to 3 images, up to 5 MB each.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure(400, "Invalid message.");
  }
  const text = form.get("text");
  const chatId = form.get("chatId");
  const files = form.getAll("files");
  if (typeof text !== "string" || (chatId !== null && !isChatId(chatId)) || !files.every((file) => file instanceof File)) {
    return failure(400, "Invalid message.");
  }
  if (files.length > MAX_ATTACHMENTS) return failure(400, "Attach up to 3 images.");

  const db = await database();
  if (!db) return failure(503, "Chats unavailable.");
  const owner = await ensureGuest();
  let saved: Awaited<ReturnType<typeof saveQuestion>>;
  try {
    const attachments = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    saved = await saveQuestion(db, { ownerId: owner, chatId, question: text, attachments });
  } catch (error) {
    if (error instanceof ChatError) return failure(error.code === "not_found" ? 404 : 400, error.message);
    return failure(503, "Chats unavailable.");
  }

  const question = questionForModel(saved.question, saved.attachments.map((file) => file.name));
  const conversation = modelConversation(saved.history, question);
  const client = assistantClient(apiKey);
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const began = Date.now();
      const events: TimedEvent[] = [];
      const answer: { turn: ApiMessage[] | null } = { turn: null };
      const send = (event: AssistantEvent) => {
        if (event.type === "done") answer.turn = event.messages;
        recordEvent(events, event, Date.now() - began);
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await runAssistant({ client, conversation, send, signal: abort.signal, systemPrompt: CHAT_PROMPT });
      } finally {
        // Saved even when the reader leaves early, so the chat keeps what was answered.
        if (!answer.turn && !events.some(({ e }) => e.type === "error")) {
          recordEvent(events, { type: "error", message: "Stopped." }, Date.now() - began);
        }
        try {
          await saveAnswer(db, { ownerId: owner, chatId: saved.chatId, question, turn: answer.turn, events });
        } catch {
          console.error("Couldn't save a chat answer.");
        }
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
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-chat-id": saved.chatId },
  });
}
