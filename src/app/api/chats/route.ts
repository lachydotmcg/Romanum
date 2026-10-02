import { after } from "next/server";
import { assistantClient, assistantRequest, runAssistant } from "@/lib/assistant/engine";
import { assertSelectionReady, formModelSelection, ModelSelectionError, resolveAssistantModel } from "@/lib/assistant/model-selection";
import type { ModelSelection } from "@/lib/models/types";
import type { ProjectChatTools } from "@/lib/projects/chat-tools";
import type { PrivateAnalyticsTools } from "@/lib/linked-games/assistant-tools";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/lib/chats/limits";
import { welcomeGuest } from "@/lib/credits/guest";
import { welcomeAccount } from "@/lib/credits/account";
import { assistantBilling } from "@/lib/assistant/billing";
import { CHAT_PROMPT } from "@/lib/chats/prompt";
import { withReferenceImages } from "@/lib/chats/vision";
import { withProjectContext } from "@/lib/projects/chat-context";
import { conversationTools } from "@/lib/projects/conversation-tools";
import {
  ChatError,
  isChatId,
  listChats,
  modelConversation,
  questionForModel,
  recordEvent,
  saveAnswer,
  type TimedEvent,
} from "@/lib/chats/store";
import { ensureOwner, readOwner, readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { verificationResponse } from "@/lib/turnstile";
import { privateAnalyticsTools } from "@/lib/linked-games/assistant-tools";
import { listLinkedGames } from "@/lib/linked-games/store";
import { adReportBackgroundEnabled } from "@/lib/ad-reports/background";
import { submitChatQuestion, ChatRunBusyError, failQueuedChatRun } from "@/lib/chats/runs";
import { executeChatRun } from "@/lib/chats/run-worker";
import { dispatchChatRun, usesBackgroundChatWorker } from "@/lib/chats/run-dispatch";

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

/** The signed-in account's chats, or the guest's, most recent first. */
export async function GET() {
  const owner = await readOwner();
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
  const projectId = form.get("projectId");
  const files = form.getAll("files");
  if (typeof text !== "string" || (chatId !== null && !isChatId(chatId)) || (projectId !== null && !isChatId(projectId)) || !files.every((file) => file instanceof File)) {
    return failure(400, "Invalid message.");
  }
  if (files.length > MAX_ATTACHMENTS) return failure(400, "Attach up to 3 images.");
  let modelSelection: ModelSelection;
  try { modelSelection = formModelSelection(form); assertSelectionReady(modelSelection); }
  catch (error) {
    if (error instanceof ModelSelectionError) return Response.json({ error: error.message, decision: error.decision }, { status: error.status, headers: NO_STORE });
    return failure(400, "Invalid model selection.");
  }

  const db = await database();
  if (!db) return failure(503, "Chats unavailable.");
  let owner: string;
  let availableCredits: number;
  // Answers spend credits, so the owner needs some before anything is saved or the model is called.
  try {
    owner = await ensureOwner(request);
    const account = await readAccount();
    const balance = account?.ownerId === owner ? await welcomeAccount(db, account.id) : await welcomeGuest(db, owner);
    availableCredits = balance.available;
    if (balance.available < 1) return failure(402, "You're out of credits.");
  } catch (error) {
    const verification = verificationResponse(error);
    if (verification) return verification;
    return failure(503, "Credits unavailable. Try again later.");
  }
  const account = await readAccount();
  const abort = new AbortController();
  let projectTools: ProjectChatTools | undefined;
  const analyticsTools: PrivateAnalyticsTools | undefined = account?.ownerId === owner ? privateAnalyticsTools(db, account.id, abort.signal) : undefined;
  let submitted: Awaited<ReturnType<typeof submitChatQuestion>>;
  try {
    const signedIn = account?.ownerId === owner;
    const useBackground = signedIn && ((await listLinkedGames(db, account.id)).some(game => game.aiAnalysis && game.collect && game.status === "active")
      || await adReportBackgroundEnabled(db, owner, { chatId, projectId }));
    const backgroundAccount = useBackground ? account!.id : null;
    const attachments = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    submitted = await submitChatQuestion(db, { ownerId: owner, chatId, projectId, question: text, attachments }, backgroundAccount, saved => {
      const question = questionForModel(saved.question, saved.attachments.map(file => file.name));
      const conversation = withProjectContext(modelConversation(saved.history, withReferenceImages(question, saved.images)), saved.project);
      projectTools = account?.ownerId === owner ? conversationTools(db, { ownerId: owner, chatId: saved.chatId, questionId: saved.questionId, project: saved.project }, abort.signal) : undefined;
      return resolveAssistantModel(modelSelection, assistantRequest(conversation, { systemPrompt: CHAT_PROMPT, projectTools, analyticsTools }), availableCredits);
    });
  } catch (error) {
    if (error instanceof ModelSelectionError) return Response.json({ error: error.message, decision: error.decision }, { status: error.status, headers: NO_STORE });
    if (error instanceof ChatRunBusyError) return failure(409, error.message);
    if (error instanceof ChatError) return failure(error.code === "not_found" ? 404 : 400, error.message);
    return failure(503, "Chats unavailable.");
  }

  const { saved, runId, modelRoute } = submitted;
  const question = questionForModel(saved.question, saved.attachments.map((file) => file.name));
  if (runId) {
    after(async () => {
      try {
        if (usesBackgroundChatWorker()) await dispatchChatRun(runId);
        else await executeChatRun(db, runId);
      } catch {
        await failQueuedChatRun(db, owner, runId).catch(() => {});
      }
    });
    return new Response("\n", { status: 202, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-chat-id": saved.chatId, "x-chat-run-id": runId } });
  }
  const conversation = withProjectContext(modelConversation(saved.history, withReferenceImages(question, saved.images)), saved.project);
  const client = assistantClient(process.env.DEEPSEEK_API_KEY ?? "");
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
      const billing = assistantBilling(db, owner, "chat");
      try {
        await runAssistant({ client, conversation, send, signal: abort.signal, systemPrompt: CHAT_PROMPT, billing, projectTools, analyticsTools, modelRoute });
      } finally {
        if (billing.credits) send({ type: "usage", credits: billing.credits });
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
