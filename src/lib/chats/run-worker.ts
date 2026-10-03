import type OpenAI from "openai";
import type { Database } from "../history/database.ts";
import type { ApiMessage, AssistantEvent } from "../assistant/types.ts";
import { assistantClient, runAssistant } from "../assistant/engine.ts";
import { assistantBilling, type AssistantBilling } from "../assistant/billing.ts";
import { CHAT_PROMPT } from "./prompt.ts";
import { readAttachment, recordEvent, modelConversation, type TimedEvent } from "./store.ts";
import { withReferenceImages } from "./vision.ts";
import { withProjectContext } from "../projects/chat-context.ts";
import { conversationTools } from "../projects/conversation-tools.ts";
import { privateAnalyticsTools, type PrivateAnalyticsTools } from "../linked-games/assistant-tools.ts";
import { appendChatRunEvents, chatRunStillActive, claimChatRun, finishChatRun } from "./runs.ts";
import { ModelSelectionError, persistedAssistantModel } from "../assistant/model-selection.ts";

/** Detached from the browser request. Durable events make the review visible across reloads. */
export async function executeChatRun(database: Database, runId: string, options: { client?: OpenAI; billing?: AssistantBilling; analyticsTools?: PrivateAnalyticsTools; checkEveryMs?: number } = {}): Promise<boolean> {
  const run = await claimChatRun(database, runId);
  if (!run) return false;
  const abort = new AbortController();
  const watchdog = setTimeout(() => abort.abort(), 13 * 60_000);
  let checking = false;
  const cancellation = setInterval(() => {
    if (checking) return;
    checking = true;
    chatRunStillActive(database, run).then(active => { if (!active) abort.abort(); }).catch(() => abort.abort()).finally(() => { checking = false; });
  }, options.checkEveryMs ?? 1000);
  const began = Date.now(), events: TimedEvent[] = [];
  let pending: TimedEvent[] = [], writes: Promise<unknown> = Promise.resolve();
  let writeFailed = false, error: string | null = null, turn: ApiMessage[] | null = null;
  const flush = () => {
    if (!pending.length) return;
    const batch = pending; pending = [];
    writes = writes.then(async () => {
      if (writeFailed || !await appendChatRunEvents(database, run, batch)) throw new Error("Review progress could not be saved.");
    }).catch(() => { writeFailed = true; abort.abort(); });
  };
  const periodic = setInterval(flush, 500);
  const send = (event: AssistantEvent) => {
    // The worker records selection before loading images; the shared engine may report the same selection.
    if (event.type === "model_selection" && events.some(({ e }) => e.type === "model_selection")) return;
    if (event.type === "done") turn = event.messages;
    if (event.type === "error") error = event.message;
    recordEvent(events, event, Date.now() - began);
    recordEvent(pending, event, Date.now() - began);
    if (!["thinking", "text"].includes(event.type)) flush();
  };
  const billing = options.billing ?? assistantBilling(database, run.ownerId, "chat", { conversationId: run.chatId, runId: run.id });
  const beforeAttempt = async () => {
    if (!await chatRunStillActive(database, run)) abort.abort();
    abort.signal.throwIfAborted();
  };
  try {
    const modelRoute = persistedAssistantModel(run.payload);
    send({ type: "model_selection", modelSelection: modelRoute.modelSelection, decision: modelRoute.modelDecision, resolvedAt: modelRoute.modelResolvedAt, ...(modelRoute.legacy ? { legacy: true } : {}) });
    await beforeAttempt();
    const images = [];
    for (const id of run.payload.attachmentIds) {
      const image = await readAttachment(database, run.ownerId, id);
      if (!image || image.mimeType !== "image/webp") throw new Error("A reference image is no longer available.");
      images.push({ mimeType: "image/webp" as const, bytes: image.bytes });
    }
    const question = withReferenceImages(run.payload.question, images);
    const conversation = withProjectContext(modelConversation(run.payload.history, question), run.payload.project);
    await runAssistant({ client: options.client ?? ((modelRoute.legacy || modelRoute.modelDecision?.modelId === "deepseek-flash") ? assistantClient(process.env.DEEPSEEK_API_KEY ?? "") : undefined), conversation, send, signal: abort.signal, billing, systemPrompt: CHAT_PROMPT,
      projectTools: conversationTools(database, { ownerId: run.ownerId, chatId: run.chatId, questionId: run.questionId, project: run.payload.project }, abort.signal),
      analyticsTools: options.analyticsTools ?? privateAnalyticsTools(database, run.accountId, abort.signal),
      beforeAttempt,
      modelRoute,
    });
  } catch (failure) {
    error = abort.signal.aborted ? "Stopped." : failure instanceof ModelSelectionError ? failure.message : "The review could not finish. Try again.";
    send({ type: "error", message: error });
  } finally {
    clearInterval(cancellation); clearInterval(periodic); clearTimeout(watchdog);
    if (!turn && !error) { error = "Stopped."; send({ type: "error", message: error }); }
    if (billing.credits) send({ type: "usage", credits: billing.credits });
    flush(); await writes;
    if (writeFailed) error = "Review progress could not be saved. Try again.";
    await finishChatRun(database, run, { turn, events, error });
  }
  return true;
}
