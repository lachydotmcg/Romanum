import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import { saveQuestion, readChat, deleteChat, questionForModel } from "../src/lib/chats/store.ts";
import { queueChatRun, claimChatRun, cancelChatRun, activeChatRun, readChatRun, appendChatRunEvents, finishChatRun, submitChatQuestion, ChatRunBusyError, failQueuedChatRun } from "../src/lib/chats/runs.ts";
import { executeChatRun } from "../src/lib/chats/run-worker.ts";
import { chatRunDispatchProof, validChatRunDispatch, usesBackgroundChatWorker } from "../src/lib/chats/run-dispatch.ts";
import { readChatRun as pollChatRun, waitForChatRun, cancelChatRun as stopChatRun, ChatRunPollError } from "../src/lib/chats/poll-run.ts";

async function fixture(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const accountId = randomUUID(), ownerId = `account:${accountId}`;
  await db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,123,'test','Test')", [accountId, ownerId]);
  const saved = await saveQuestion(db, { ownerId, chatId: null, question: "Review my game's funnel", attachments: [] });
  const payload = { question: questionForModel(saved.question, []), history: saved.history, attachmentIds: [], project: saved.project };
  const input = { accountId, ownerId, chatId: saved.chatId, questionId: saved.questionId, payload };
  const id = await queueChatRun(db, input);
  return { db, accountId, ownerId, saved, payload, input, id };
}
const billing = () => ({ credits: 0, reserve: async () => randomUUID(), settle: async () => {}, finish: async () => {}, tool: async (_, execute) => execute() });

test("dispatch proofs are purpose-, run- and time-bound, and never reveal the sealing key", () => {
  const key = randomBytes(32), id = randomUUID(), at = Date.now();
  const proof = chatRunDispatchProof(key, id, at);
  assert.equal(validChatRunDispatch(key, id, proof, at), true);
  assert.equal(validChatRunDispatch(key, randomUUID(), proof, at), false);
  assert.equal(validChatRunDispatch(randomBytes(32), id, proof, at), false);
  assert.equal(validChatRunDispatch(key, id, proof, at + 300001), false);
  assert.equal(validChatRunDispatch(key, id, "malformed", at), false);
  assert.ok(!proof.includes(key.toString("base64")));
});

test("Netlify runtime detection uses SITE_ID even when its build-only flags are absent", t => {
  const names = ["ROMANUM_CHAT_RUN_ORIGIN", "SITE_ID", "NETLIFY"];
  const original = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => original[index] === undefined ? delete process.env[name] : process.env[name] = original[index]));
  names.forEach(name => delete process.env[name]);
  assert.equal(usesBackgroundChatWorker(), false);
  process.env.SITE_ID = randomUUID();
  assert.equal(usesBackgroundChatWorker(), true);
});

test("queue/progress/cancel are owner-scoped, and dispatch can claim a question only once", async t => {
  const f = await fixture(t);
  assert.deepEqual(await activeChatRun(f.db, f.ownerId, f.saved.chatId), { id: f.id });
  assert.equal(await readChatRun(f.db, "stranger", f.id), null);
  assert.equal(await cancelChatRun(f.db, "stranger", f.id), false);
  await assert.rejects(queueChatRun(f.db, { ...f.input, ownerId: "stranger" }));
  const claims = await Promise.all([claimChatRun(f.db, f.id), claimChatRun(f.db, f.id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const run = claims.find(Boolean);
  const events = Array.from({ length: 250 }, (_, i) => ({ t: i, e: { type: "text", delta: String(i) } }));
  assert.equal(await appendChatRunEvents(f.db, run, events), true);
  assert.equal(await appendChatRunEvents(f.db, { ...run, claim: randomUUID() }, events), false);
  assert.equal(await finishChatRun(f.db, run, { turn: [{ role: "assistant", content: "Review complete" }], events: [{ t: 251, e: { type: "done", messages: [] } }], error: null }), true);
  const page = await readChatRun(f.db, f.ownerId, f.id);
  assert.equal(page.events.length, 200);
  assert.equal(page.cursor, 200);
  assert.equal(page.status, "complete");
  assert.ok(!JSON.stringify(page).includes(run.claim));
  const next = await readChatRun(f.db, f.ownerId, f.id, page.cursor);
  assert.equal(next.events.length, 50);
  assert.equal(next.cursor, 250);
  assert.equal(await claimChatRun(f.db, f.id), null);
  assert.equal(await finishChatRun(f.db, run, { turn: [], events: [], error: null }), false);
  assert.equal((await readChat(f.db, f.ownerId, f.saved.chatId)).messages.filter(message => message.role === "assistant").length, 1);
  assert.equal((await f.db.query("SELECT payload FROM chat_runs WHERE id=$1", [f.id])).rows[0].payload, null);
});

test("cancelled queued work and expired ambiguous work never start again; deleting a chat removes its progress", async t => {
  const f = await fixture(t);
  assert.equal(await cancelChatRun(f.db, f.ownerId, f.id), true);
  assert.equal(await claimChatRun(f.db, f.id), null);
  assert.equal((await readChatRun(f.db, f.ownerId, f.id)).status, "cancelled");
  const saved = await saveQuestion(f.db, { ownerId: f.ownerId, chatId: f.saved.chatId, question: "Try again", attachments: [] });
  const id = await queueChatRun(f.db, { ...f.input, questionId: saved.questionId });
  const run = await claimChatRun(f.db, id);
  await appendChatRunEvents(f.db, run, [{ t: 1, e: { type: "text", delta: "Preserve this partial review" } }]);
  await f.db.query("UPDATE chat_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
  assert.equal((await readChatRun(f.db, f.ownerId, id)).status, "failed");
  const recovered = await readChat(f.db, f.ownerId, f.saved.chatId);
  assert.ok(recovered.messages.at(-1).events.some(event => event.e.delta === "Preserve this partial review"));
  assert.ok(recovered.messages.at(-1).events.some(event => event.e.type === "error"));
  assert.equal(await activeChatRun(f.db, f.ownerId, f.saved.chatId), null);
  assert.equal(await claimChatRun(f.db, id), null);
  await deleteChat(f.db, f.ownerId, f.saved.chatId);
  assert.equal(await readChatRun(f.db, f.ownerId, f.id), null);
});

test("overlapping tabs save only the winning question and run; dispatch failures save one terminal answer", async t => {
  const f = await fixture(t);
  await cancelChatRun(f.db, f.ownerId, f.id);
  const before = (await readChat(f.db, f.ownerId, f.saved.chatId)).messages.length;
  const input = { ownerId: f.ownerId, chatId: f.saved.chatId, question: "Next review", attachments: [] };
  const submitted = await Promise.allSettled([submitChatQuestion(f.db, input, f.accountId), submitChatQuestion(f.db, input, f.accountId)]);
  assert.equal(submitted.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(submitted.find(result => result.status === "rejected").reason instanceof ChatRunBusyError);
  assert.equal((await readChat(f.db, f.ownerId, f.saved.chatId)).messages.length, before + 1);
  const { runId } = submitted.find(result => result.status === "fulfilled").value;
  await failQueuedChatRun(f.db, f.ownerId, runId);
  await failQueuedChatRun(f.db, f.ownerId, runId);
  assert.equal((await readChat(f.db, f.ownerId, f.saved.chatId)).messages.length, before + 2);
});

test("Stop or account deletion during settlement prevents the next provider and tool attempt", async t => {
  for (const deletion of [false, true]) {
    const f = await fixture(t); let calls = 0, settles = 0;
    const client = { chat: { completions: { create: async () => {
      calls++;
      return (async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "lookup", function: { name: "get_private_analytics_catalog", arguments: "{}" } }] } }] };
        yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      })();
    } } } };
    const fees = { ...billing(), settle: async () => {
      settles++;
      if (deletion) await closeAccount(f.db, { id: f.accountId, ownerId: f.ownerId });
      else await cancelChatRun(f.db, f.ownerId, f.id);
    } };
    await executeChatRun(f.db, f.id, { client, billing: fees, checkEveryMs: 60000 });
    assert.equal(calls, 1); assert.equal(settles, 1);
    if (deletion) assert.equal(await readChatRun(f.db, f.ownerId, f.id), null);
    else assert.equal((await readChatRun(f.db, f.ownerId, f.id)).status, "cancelled");
  }
});

test("background model execution commits a replayable answer and usage exactly once, without a browser connection", async t => {
  const f = await fixture(t); let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return (async function* () {
      yield { choices: [{ delta: { content: "Look at the biggest funnel drop first." } }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    })();
  } } } };
  const fees = { ...billing(), credits: 0.5 };
  assert.equal(await executeChatRun(f.db, f.id, { client, billing: fees }), true);
  assert.equal(await executeChatRun(f.db, f.id, { client, billing: fees }), false);
  assert.equal(calls, 1);
  const progress = await readChatRun(f.db, f.ownerId, f.id);
  assert.equal(progress.status, "complete");
  assert.ok(progress.events.some(event => event.e.type === "usage" && event.e.credits === 0.5));
  assert.ok(progress.events.some(event => event.e.type === "done"));
  const chat = await readChat(f.db, f.ownerId, f.saved.chatId);
  assert.equal(chat.messages.length, 2);
  assert.ok(chat.messages[1].events.some(event => event.e.type === "text"));
});

test("an owner Stop aborts the background provider attempt and saves a stopped answer", async t => {
  const f = await fixture(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = { chat: { completions: { create: async (_, { signal }) => (async function* () {
    started();
    yield { choices: [{ delta: { content: "Partial review" } }] };
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  })() } } };
  const pending = executeChatRun(f.db, f.id, { client, billing: billing(), checkEveryMs: 20 });
  await ready; await cancelChatRun(f.db, f.ownerId, f.id); await pending;
  const progress = await readChatRun(f.db, f.ownerId, f.id);
  assert.equal(progress.status, "cancelled");
  assert.ok(progress.events.some(event => event.e.type === "error" && event.e.message === "Stopped."));
});

test("poll helper preserves the cursor wire contract, bounds transient failures and honours aborts", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let requested;
  globalThis.fetch = async url => { requested = url; return Response.json({ status: "running", error: null, cursor: 2, events: [{ at: 1, e: { type: "text", delta: "Hello" } }] }); };
  const signal = new AbortController().signal;
  assert.equal((await pollChatRun("run", 1, signal)).cursor, 2);
  assert.equal(requested, "/api/chats/runs/run?after=1");
  globalThis.fetch = async () => Response.json({ error: "Unavailable" }, { status: 503 });
  await assert.rejects(pollChatRun("run", 1, signal), error => error instanceof ChatRunPollError && error.retryable);
  globalThis.fetch = async () => Response.json({ error: "Not yours" }, { status: 404 });
  await assert.rejects(pollChatRun("run", 1, signal), error => error instanceof ChatRunPollError && !error.retryable);
  await assert.rejects(waitForChatRun(AbortSignal.abort(), 1000));
  globalThis.fetch = async (url, init) => { requested = [url, init.method]; return new Response(null, { status: 204 }); };
  await stopChatRun("run");
  assert.deepEqual(requested, ["/api/chats/runs/run", "DELETE"]);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(stopChatRun("run"), /could not be stopped/);
  globalThis.fetch = async () => Response.json({ status: "running", cursor: 2, events: [{ at: 0, e: null }] });
  await assert.rejects(pollChatRun("run", 1, signal), error => error instanceof ChatRunPollError && !error.retryable);
  // A stalled fetch is retryable; leaving the page is a separate non-retry abort.
  globalThis.fetch = async (_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(pollChatRun("run", 1, signal, 5), error => error instanceof ChatRunPollError && error.retryable); }
  finally { clearTimeout(keepAlive); }
});
