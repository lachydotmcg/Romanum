import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../history/database.ts";
import type { ApiMessage } from "../assistant/types.ts";
import type { ChatProject } from "../projects/chat-context.ts";
import { isChatId, saveAnswer, saveQuestion, questionForModel, type TimedEvent } from "./store.ts";

export type ChatRunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type ChatRunPayload = { history: ApiMessage[]; question: ApiMessage; attachmentIds: string[]; project: ChatProject | null };
export type ClaimedChatRun = { id: string; accountId: string; ownerId: string; chatId: string; questionId: string; claim: string; payload: ChatRunPayload };

export class ChatRunBusyError extends Error {}
const transactionDatabase = (sql: Sql): Database => ({ ...sql, transaction: fn => fn(sql), close: async () => {} });

/** The question and its run are one commit, so a competing tab cannot leave an orphan question. */
export async function submitChatQuestion(database: Database, input: Parameters<typeof saveQuestion>[1], accountId: string | null) {
  return database.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.ownerId]);
    const db = transactionDatabase(sql);
    if (input.chatId && await activeChatRun(db, input.ownerId, input.chatId)) throw new ChatRunBusyError("This chat is still responding. Stop the review or wait for it to finish.");
    const saved = await saveQuestion(db, input);
    const runId = accountId ? await queueChatRun(db, { accountId, ownerId: input.ownerId, chatId: saved.chatId, questionId: saved.questionId,
      payload: { question: questionForModel(saved.question, saved.attachments.map(file => file.name)), history: saved.history, attachmentIds: saved.attachments.map(file => file.id), project: saved.project },
    }) : null;
    return { saved, runId };
  });
}

/** Persist partial output before releasing work whose worker vanished, or which never started. */
async function endWithoutWorker(database: Database, ownerId: string, select: { id?: string; chatId?: string }, reason: "expired" | "dispatch" | "cancel") {
  return database.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [ownerId]);
    const condition = reason === "expired" ? "((status='running' AND lease_until<now()) OR (status='queued' AND created_at<now()-interval '5 minutes'))" : "status='queued'";
    const { rows } = await sql.query<{ id: string; chat_id: string; payload: ChatRunPayload; events: TimedEvent[] }>(
      `SELECT id,chat_id,payload,events FROM chat_runs WHERE owner_id=$1 AND ${select.id ? "id" : "chat_id"}=$2 AND ${condition} FOR UPDATE`, [ownerId, select.id ?? select.chatId],
    );
    for (const row of rows) {
      const error = reason === "cancel" ? "Stopped." : reason === "dispatch" ? "The review could not start. Try again." : "The review was interrupted. Start a new message to continue.";
      const events: TimedEvent[] = [...row.events, { t: row.events.at(-1)?.t ?? 0, e: { type: "error", message: error } }];
      if (row.payload) await saveAnswer(transactionDatabase(sql), { ownerId, chatId: row.chat_id, question: row.payload.question, turn: null, events });
      const body = JSON.stringify(events), bytes = Buffer.byteLength(body);
      const append = events.length <= 10000 && bytes <= 2097152;
      await sql.query(`UPDATE chat_runs SET status=$3,error=$4,payload=NULL,lease_until=NULL,finished_at=now(),cancel_requested=$5,
        events=CASE WHEN $6 THEN $7::jsonb ELSE events END,event_count=CASE WHEN $6 THEN $8 ELSE event_count END,event_bytes=CASE WHEN $6 THEN $9 ELSE event_bytes END WHERE id=$1 AND owner_id=$2`,
      [row.id, ownerId, reason === "cancel" ? "cancelled" : "failed", error, reason === "cancel", append, body, events.length, bytes]);
    }
    return rows.length > 0;
  });
}

export async function activeChatRun(database: Database, ownerId: string, chatId: string): Promise<{ id: string } | null> {
  if (!isChatId(chatId)) return null;
  await endWithoutWorker(database, ownerId, { chatId }, "expired");
  const { rows } = await database.query<{ id: string }>("SELECT id FROM chat_runs WHERE owner_id=$1 AND chat_id=$2 AND status IN ('queued','running')", [ownerId, chatId]);
  return rows[0] ?? null;
}

/** All identity and context fields come from the authenticated question transaction. */
export async function queueChatRun(database: Database, input: { accountId: string; ownerId: string; chatId: string; questionId: string; payload: ChatRunPayload }): Promise<string> {
  const id = randomUUID();
  if (Buffer.byteLength(JSON.stringify(input.payload)) > 1_000_000) throw new Error("Chat context is too large.");
  const { rows } = await database.query(
    `INSERT INTO chat_runs(id,account_id,owner_id,chat_id,question_id,payload)
     SELECT $1,a.id,a.owner_id,c.id,m.id,$6 FROM accounts a JOIN chats c ON c.owner_id=a.owner_id JOIN chat_messages m ON m.chat_id=c.id
     WHERE a.id=$2 AND a.owner_id=$3 AND c.id=$4 AND m.id=$5 AND m.role='user' RETURNING id`,
    [id, input.accountId, input.ownerId, input.chatId, input.questionId, JSON.stringify(input.payload)],
  );
  if (!rows.length) throw new Error("Chat not found.");
  return id;
}

/** A signed dispatch can claim once. Expired/ambiguous work is never automatically rerun or billed twice. */
export async function claimChatRun(database: Database, runId: string): Promise<ClaimedChatRun | null> {
  if (!isChatId(runId)) return null;
  const claim = randomUUID();
  const { rows } = await database.query<{ id: string; account_id: string; owner_id: string; chat_id: string; question_id: string; payload: ChatRunPayload }>(
    `UPDATE chat_runs SET status='running',claim_token=$2,started_at=now(),lease_until=now()+interval '14 minutes'
     WHERE id=$1 AND status='queued' AND NOT cancel_requested AND created_at > now()-interval '5 minutes' RETURNING id,account_id,owner_id,chat_id,question_id,payload`,
    [runId, claim],
  );
  const row = rows[0];
  return row ? { id: row.id, accountId: row.account_id, ownerId: row.owner_id, chatId: row.chat_id, questionId: row.question_id, claim, payload: row.payload } : null;
}

export async function chatRunStillActive(database: Database, run: ClaimedChatRun): Promise<boolean> {
  const { rows } = await database.query("SELECT id FROM chat_runs WHERE id=$1 AND owner_id=$2 AND claim_token=$3 AND status='running' AND NOT cancel_requested AND lease_until>now()", [run.id, run.ownerId, run.claim]);
  return rows.length === 1;
}

export async function appendChatRunEvents(database: Database, run: ClaimedChatRun, events: TimedEvent[]): Promise<boolean> {
  if (!events.length) return true;
  const body = JSON.stringify(events), bytes = Buffer.byteLength(body);
  const { rows } = await database.query(
    `UPDATE chat_runs SET events=events || $4::jsonb,event_count=event_count+$5,event_bytes=event_bytes+$6
     WHERE id=$1 AND owner_id=$2 AND claim_token=$3 AND status='running' AND lease_until>now()
       AND event_count+$5<=10000 AND event_bytes+$6<=2097152 RETURNING id`,
    [run.id, run.ownerId, run.claim, body, events.length, bytes],
  );
  return rows.length === 1;
}

/** Final status, model history and replayable answer commit together under the owner's usual lock. */
export async function finishChatRun(database: Database, run: ClaimedChatRun, input: { turn: ApiMessage[] | null; events: TimedEvent[]; error: string | null }): Promise<boolean> {
  return database.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [run.ownerId]);
    const { rows } = await sql.query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM chat_runs WHERE id=$1 AND owner_id=$2 AND claim_token=$3 AND status='running' FOR UPDATE", [run.id, run.ownerId, run.claim]);
    if (!rows.length) return false;
    const db = transactionDatabase(sql);
    await saveAnswer(db, { ownerId: run.ownerId, chatId: run.chatId, question: run.payload.question, turn: input.turn, events: input.events });
    const status = rows[0].cancel_requested ? "cancelled" : input.error ? "failed" : "complete";
    await sql.query("UPDATE chat_runs SET status=$4,error=$5,payload=NULL,lease_until=NULL,finished_at=now() WHERE id=$1 AND owner_id=$2 AND claim_token=$3", [run.id, run.ownerId, run.claim, status, input.error?.slice(0, 200) ?? null]);
    return true;
  });
}

export async function failQueuedChatRun(database: Database, ownerId: string, id: string): Promise<void> {
  await endWithoutWorker(database, ownerId, { id }, "dispatch");
}

/** Only the owner can stop work. A running worker observes cancellation before further calls. */
export async function cancelChatRun(database: Database, ownerId: string, id: string): Promise<boolean> {
  if (await endWithoutWorker(database, ownerId, { id }, "cancel")) return true;
  const { rows } = await database.query(
    "UPDATE chat_runs SET cancel_requested=true WHERE id=$1 AND owner_id=$2 RETURNING id", [id, ownerId],
  );
  return rows.length === 1;
}

export async function readChatRun(database: Database, ownerId: string, id: string, after = 0) {
  if (!isChatId(id) || !Number.isSafeInteger(after) || after < 0 || after > 10000) return null;
  // A vanished worker cannot leave a forever-running chat. Do not retry ambiguous provider work.
  await endWithoutWorker(database, ownerId, { id }, "expired");
  const { rows } = await database.query<{ status: ChatRunStatus; error: string | null; event_count: number; page: TimedEvent[] }>(
    `SELECT r.status,r.error,r.event_count,
       COALESCE((SELECT jsonb_agg(p.event ORDER BY p.n) FROM (SELECT e.event,e.n FROM jsonb_array_elements(r.events) WITH ORDINALITY AS e(event,n) WHERE e.n>$3 ORDER BY e.n LIMIT 200) p),'[]'::jsonb) AS page
     FROM chat_runs r WHERE r.id=$1 AND r.owner_id=$2`, [id, ownerId, after],
  );
  const row = rows[0];
  return row ? { events: row.page.map(event => ({ e: event.e, at: event.t })), cursor: Math.min(after + row.page.length, row.event_count), status: row.status, error: row.error } : null;
}
