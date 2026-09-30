import type { AssistantEvent } from "@/lib/assistant/types";

// A durable chat run: the answer outlives the request that started it, so the browser follows it by polling
// for the events that were recorded after a cursor. This module owns the wire format and its failure modes.

/** The most events one poll can return; a full page means there is more to drain. */
export const CHAT_RUN_PAGE_LIMIT = 200;
/** How long to wait between polls while a run is still queued or running. */
export const CHAT_RUN_POLL_MS = 1000;
/** How many transient failures in a row are retried before the run is treated as unreachable. */
export const CHAT_RUN_MAX_RETRIES = 4;

export type ChatRunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

/** One recorded event and when it happened, in milliseconds after the answer started. */
export type ChatRunEvent = { e: AssistantEvent; at: number };

/** One page of a running answer: events after the cursor, the new cursor, and the run's state. */
export type ChatRunPage = { events: ChatRunEvent[]; cursor: number; status: ChatRunStatus; error: string | null };

export const isChatRunStatus = (value: unknown): value is ChatRunStatus =>
  value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "cancelled";

export const isTerminalChatRun = (status: ChatRunStatus) => status === "complete" || status === "failed" || status === "cancelled";

/** A failed poll. `retryable` marks the transient network and 5xx failures worth a bounded retry. */
export class ChatRunPollError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ChatRunPollError";
    this.retryable = retryable;
  }
}

/** The message shown on a turn that ended without a usable answer. */
export function chatRunFailureMessage(page: Pick<ChatRunPage, "status" | "error">): string {
  if (page.error) return page.error;
  if (page.status === "cancelled") return "Stopped.";
  return "The response ended unexpectedly.";
}

function parseEvent(value: unknown): ChatRunEvent | null {
  if (!value || typeof value !== "object") return null;
  const { e, at } = value as { e?: unknown; at?: unknown };
  if (!e || typeof e !== "object" || typeof (e as { type?: unknown }).type !== "string") return null;
  return { e: e as AssistantEvent, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
}

function parsePage(value: unknown, after: number): ChatRunPage {
  if (!value || typeof value !== "object") throw new ChatRunPollError("The assistant sent an unexpected reply.", false);
  const record = value as Record<string, unknown>;
  if (!isChatRunStatus(record.status)) throw new ChatRunPollError("The assistant sent an unexpected reply.", false);
  if (typeof record.cursor !== "number" || !Number.isSafeInteger(record.cursor) || record.cursor < after || record.cursor > 10000) throw new ChatRunPollError("The assistant sent an unexpected reply.", false);
  const cursor = record.cursor;
  if (!Array.isArray(record.events) || record.events.length > CHAT_RUN_PAGE_LIMIT) throw new ChatRunPollError("The assistant sent an unexpected reply.", false);
  const events = record.events.map(parseEvent);
  if (events.some(event => event === null) || cursor !== after + events.length) throw new ChatRunPollError("The assistant sent an unexpected reply.", false);
  return { events: events as ChatRunEvent[], cursor, status: record.status, error: typeof record.error === "string" && record.error ? record.error : null };
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

/** Reads the events recorded after `after`. Throws `ChatRunPollError`, or an AbortError once the signal fires. */
export async function readChatRun(runId: string, after: number, signal: AbortSignal, timeoutMs = 10000): Promise<ChatRunPage> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await fetch(`/api/chats/runs/${encodeURIComponent(runId)}?after=${after}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal: requestSignal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      requestSignal.throwIfAborted();
      const message = typeof body?.error === "string" && body.error ? body.error : `Retrieving the answer failed (${response.status}).`;
      const transient = response.status >= 500 || response.status === 408 || response.status === 429;
      throw new ChatRunPollError(message, transient);
    }
    const page = await response.json().catch(() => null);
    requestSignal.throwIfAborted();
    return parsePage(page, after);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ChatRunPollError) throw error;
    throw new ChatRunPollError("We lost contact with the assistant.", true);
  }
}

/** Cancels a run so its work stops server-side; used by the explicit Stop button. */
export async function cancelChatRun(runId: string): Promise<void> {
  const response = await fetch(`/api/chats/runs/${encodeURIComponent(runId)}`, { method: "DELETE", cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("The review could not be stopped. It may still be running; try Stop again.");
}

/** Backoff before retrying a transient poll failure: 1s, 2s, 3s, then 4s. */
export const chatRunRetryDelay = (attempt: number) => Math.min(CHAT_RUN_POLL_MS * attempt, CHAT_RUN_POLL_MS * CHAT_RUN_MAX_RETRIES);

/** Waits between polls, rejecting if the signal aborts first so a stalled poll never outlives its page. */
export function waitForChatRun(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
