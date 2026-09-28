import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { MAX_PROJECTS, createProject, updateProject } from "../src/lib/projects/store.ts";
import { questionForModel, readChat, saveAnswer, saveQuestion } from "../src/lib/chats/store.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import {
  ConversationContextError,
  chatProjectContextSchema,
  saveChatProjectContext,
} from "../src/lib/projects/conversation-context.ts";

// Chat-first project saves run on the real application schema, migrated in full,
// in an isolated in-memory database. Every account, chat and brief below is
// invented test data: no provider is called, no image is generated and no
// credential is read.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: "red" } }).png().toBuffer();
const context = { game: "Reef tycoon", gameplay: "Grow and trade corals", audience: "Families", artDirection: "Soft flat shapes", constraints: ["Readable on mobile"] };

async function newAccount(db, robloxUserId, ownerId = `account:${randomUUID()}`) {
  const id = randomUUID();
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,picture_url) VALUES($1,$2,$3,$4,$5,NULL)", [id, robloxUserId, ownerId, `user${robloxUserId}`, `User ${robloxUserId}`]);
  return { id, ownerId };
}

const count = async (db, table, where = "true", values = []) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n);

const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a ConversationContextError"), (thrown) => thrown);
  assert.ok(error instanceof ConversationContextError, `expected ConversationContextError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};

const ask = (db, ownerId, question = "Save this brief", chatId = null, attachments = []) => saveQuestion(db, { ownerId, chatId, question, attachments });
const save = (db, ownerId, chatId, questionId, overrides = {}) => saveChatProjectContext(db, { ownerId, chatId, questionId, expectedRevision: 0, name: "Reef", context, ...overrides });

test("only a signed-in account may save, and the whole request is strict", async (t) => {
  const db = await database(t);
  // A name that merely looks like an account is not one until an account row exists.
  const stranger = "account:looks-signed-in";
  const unsigned = await ask(db, stranger);
  await rejection(save(db, stranger, unsigned.chatId, unsigned.questionId), "not_found");
  assert.equal(await count(db, "creative_projects"), 0);

  const account = await newAccount(db, 5201);
  const chat = await ask(db, account.ownerId);
  const base = { ownerId: account.ownerId, chatId: chat.chatId, questionId: chat.questionId, expectedRevision: 0, name: "Reef", context };
  assert.equal(chatProjectContextSchema.safeParse(base).success, true);
  // Blank optional values are valid, and so is a written plan, roadmap and todos.
  assert.equal(chatProjectContextSchema.safeParse({ ...base, context: { game: "Reef", gameplay: "", audience: "", artDirection: "", constraints: [], plan: "", roadmap: [], todos: [] } }).success, true);

  // Identity, project and revision are server-scoped: no extra field is accepted.
  for (const injected of [{ model: "fixture" }, { projectId: randomUUID() }, { projectRevision: 1 }, { archived: false }, { callId: "x" }, { extra: 1 }]) {
    await rejection(saveChatProjectContext(db, { ...base, ...injected }), "invalid_input");
  }
  for (const bad of [
    { name: "   " },
    { name: "n".repeat(101) },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: "1" },
    { chatId: "not-a-uuid" },
    { questionId: "not-a-uuid" },
    { context: { ...context, extra: "x" } },
    { context: { ...context, plan: "p".repeat(12001) } },
    { context: { ...context, roadmap: Array.from({ length: 13 }, () => ({ title: "T", detail: "" })) } },
    { context: { ...context, todos: Array.from({ length: 41 }, (_, index) => ({ id: `t${index}`, text: "Do", done: false })) } },
  ]) {
    await rejection(saveChatProjectContext(db, { ...base, ...bad }), "invalid_input");
  }
  assert.equal(await count(db, "creative_projects"), 0);
});

test("saving creates one project from the chat and keeps its history and images", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5202);
  const first = await saveQuestion(db, { ownerId: account.ownerId, chatId: null, question: "Plan the first session", attachments: [{ name: "ref.png", bytes: png }] });
  await saveAnswer(db, { ownerId: account.ownerId, chatId: first.chatId, question: questionForModel("Plan the first session", ["ref.png"]), turn: [{ role: "assistant", content: "Start with one coral." }], events: [] });
  const second = await ask(db, account.ownerId, "Save this brief", first.chatId);
  const before = await readChat(db, account.ownerId, first.chatId);
  const historyBefore = (await db.query("SELECT history FROM chats WHERE id=$1", [first.chatId])).rows[0].history;
  assert.equal(before.projectId, null);
  assert.equal(before.messages.length, 3);
  assert.equal(before.messages[0].attachments.length, 1);

  // The name is trimmed; the context keeps the store's own defaults.
  const project = await save(db, account.ownerId, first.chatId, second.questionId, { name: "  Reef  ", context: { game: "Reef tycoon" } });
  assert.equal(project.archived, false);
  assert.equal(project.revision, 1);
  assert.equal(project.name, "Reef");
  assert.deepEqual(project.context, { game: "Reef tycoon", gameplay: "", audience: "", artDirection: "", constraints: [] });
  assert.equal(new Date(project.updatedAt).toISOString(), project.updatedAt);

  const after = await readChat(db, account.ownerId, first.chatId);
  assert.equal(after.id, before.id, "the chat is not recreated");
  assert.equal(after.projectId, project.id);
  assert.deepEqual(after.messages.map((message) => message.id), before.messages.map((message) => message.id), "messages are not deleted");
  assert.equal(after.messages[0].attachments.length, 1, "images are not deleted");
  assert.deepEqual((await db.query("SELECT history FROM chats WHERE id=$1", [first.chatId])).rows[0].history, historyBefore, "the model history is untouched");
  assert.equal(await count(db, "chats"), 1);
  assert.equal(await count(db, "chat_messages"), 3);
  assert.equal(await count(db, "creative_projects"), 1);
});

test("a later save updates the same project under its revision and never reassigns the chat", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5203);
  const chat = await ask(db, account.ownerId);
  const created = await save(db, account.ownerId, chat.chatId, chat.questionId);
  const refine = await ask(db, account.ownerId, "Refine the brief", chat.chatId);
  const updated = await save(db, account.ownerId, chat.chatId, refine.questionId, {
    expectedRevision: 1,
    name: "Reef",
    context: { ...context, gameplay: "Explore sunken ships", todos: [{ id: "art", text: "Draw coral", done: false }] },
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.context.gameplay, "Explore sunken ships");
  assert.deepEqual(updated.context.todos, [{ id: "art", text: "Draw coral", done: false }]);
  assert.equal((await readChat(db, account.ownerId, chat.chatId)).projectId, created.id);
  assert.equal(await count(db, "creative_projects"), 1, "no second project is created");

  // The chat is never moved to another of the owner's projects, and there is no projectId input.
  const other = await createProject(db, { ownerId: account.ownerId, name: "Other", context });
  const hijack = await ask(db, account.ownerId, "Switch projects", chat.chatId);
  await rejection(saveChatProjectContext(db, { ownerId: account.ownerId, chatId: chat.chatId, questionId: hijack.questionId, expectedRevision: 2, name: "Hijack", context, projectId: other.id }), "invalid_input");
  assert.equal((await readChat(db, account.ownerId, chat.chatId)).projectId, created.id);
  assert.equal((await db.query("SELECT context FROM creative_projects WHERE id=$1", [created.id])).rows[0].context.gameplay, "Explore sunken ships");
});

test("the same normalized content is an idempotent no-op, even on a stale revision", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5204);
  const chat = await ask(db, account.ownerId);
  const created = await save(db, account.ownerId, chat.chatId, chat.questionId, { name: "Reef", context: { game: "Reef tycoon" } });
  const repeat = await ask(db, account.ownerId, "Save the same brief", chat.chatId);
  // Defaults applied make this the same stored content, so the stale revision is ignored.
  const again = await save(db, account.ownerId, chat.chatId, repeat.questionId, {
    expectedRevision: 0,
    name: "Reef",
    context: { game: "Reef tycoon", gameplay: "", audience: "", artDirection: "", constraints: [] },
  });
  assert.deepEqual(again, created);
  assert.equal((await db.query("SELECT revision FROM creative_projects WHERE id=$1", [created.id])).rows[0].revision, 1);

  // Different content on a stale revision is a conflict and the stored brief stands.
  const change = await ask(db, account.ownerId, "Change the brief", chat.chatId);
  await rejection(save(db, account.ownerId, chat.chatId, change.questionId, { expectedRevision: 0, name: "Reef", context: { ...context, gameplay: "Changed" } }), "conflict");
  assert.equal((await db.query("SELECT context FROM creative_projects WHERE id=$1", [created.id])).rows[0].context.gameplay, "");
});

test("a stale revision cannot overwrite a newer decision, even concurrently", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5205);
  const chat = await ask(db, account.ownerId);
  const created = await save(db, account.ownerId, chat.chatId, chat.questionId);
  const decision = await ask(db, account.ownerId, "Second decision", chat.chatId);
  const settled = await Promise.allSettled([
    save(db, account.ownerId, chat.chatId, decision.questionId, { expectedRevision: 1, name: "Reef", context: { ...context, gameplay: "Route A" } }),
    save(db, account.ownerId, chat.chatId, decision.questionId, { expectedRevision: 1, name: "Reef", context: { ...context, gameplay: "Route B" } }),
  ]);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const failed = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, "conflict");
  const winner = fulfilled[0].value;
  assert.equal(winner.revision, 2);
  const stored = (await db.query("SELECT revision, context FROM creative_projects WHERE id=$1", [created.id])).rows[0];
  assert.equal(stored.revision, 2);
  assert.equal(stored.context.gameplay, winner.context.gameplay, "the stored brief is the edit that won");
});

test("an archived project refuses saves while its stored brief stands", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5206);
  const chat = await ask(db, account.ownerId);
  const created = await save(db, account.ownerId, chat.chatId, chat.questionId);
  await updateProject(db, { ownerId: account.ownerId, id: created.id, revision: 1, name: created.name, context: created.context, archived: true });
  const archivedQuestion = await ask(db, account.ownerId, "Save while archived", chat.chatId);
  await rejection(save(db, account.ownerId, chat.chatId, archivedQuestion.questionId, { expectedRevision: 2, name: "Reef", context: { ...context, gameplay: "New" } }), "conflict");
  // Same content while archived is still refused: the archive check holds.
  await rejection(save(db, account.ownerId, chat.chatId, archivedQuestion.questionId, { expectedRevision: 0 }), "conflict");
  const row = (await db.query("SELECT revision, archived, context FROM creative_projects WHERE id=$1", [created.id])).rows[0];
  assert.equal(row.revision, 2);
  assert.equal(row.archived, true);
  assert.deepEqual(row.context, created.context);

  // Restoring reopens saves on the same project.
  await updateProject(db, { ownerId: account.ownerId, id: created.id, revision: 2, name: created.name, context: created.context, archived: false });
  const restoredQuestion = await ask(db, account.ownerId, "Back again", chat.chatId);
  const restored = await save(db, account.ownerId, chat.chatId, restoredQuestion.questionId, { expectedRevision: 3, name: "Reef", context: { ...context, gameplay: "After restore" } });
  assert.equal(restored.id, created.id);
  assert.equal(restored.revision, 4);
  assert.equal(restored.archived, false);
});

test("only the chat's most recent user question may save", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5207);
  const first = await ask(db, account.ownerId, "First question");
  const second = await ask(db, account.ownerId, "Second question", first.chatId);

  await rejection(save(db, account.ownerId, first.chatId, first.questionId), "conflict", "an old question cannot decide");
  await rejection(save(db, account.ownerId, first.chatId, randomUUID()), "not_found");
  await rejection(save(db, account.ownerId, first.chatId, second.questionId, { expectedRevision: 1 }), "conflict", "a chat with no project needs revision 0");
  const other = await ask(db, account.ownerId, "Other chat");
  await rejection(save(db, account.ownerId, first.chatId, other.questionId), "not_found");
  await rejection(save(db, account.ownerId, other.chatId, second.questionId), "not_found");

  // An answer's message is never a question.
  await saveAnswer(db, { ownerId: account.ownerId, chatId: first.chatId, question: questionForModel("Second question", []), turn: [{ role: "assistant", content: "Sure." }], events: [] });
  const answer = (await db.query("SELECT id FROM chat_messages WHERE chat_id=$1 AND role='assistant'", [first.chatId])).rows[0];
  await rejection(save(db, account.ownerId, first.chatId, answer.id), "not_found");

  const project = await save(db, account.ownerId, first.chatId, second.questionId);
  assert.equal(project.revision, 1);
  assert.equal((await readChat(db, account.ownerId, first.chatId)).projectId, project.id);
});

test("todo ids must be distinct", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5208);
  const chat = await ask(db, account.ownerId);
  const duplicate = [{ id: "art", text: "Draw coral", done: false }, { id: "art", text: "Draw coral again", done: true }];
  await rejection(save(db, account.ownerId, chat.chatId, chat.questionId, { context: { ...context, todos: duplicate } }), "invalid_input");
  assert.equal(await count(db, "creative_projects"), 0);

  const todos = [{ id: "art", text: "Draw coral", done: false }, { id: "code", text: "Ship growth", done: true }];
  const saved = await save(db, account.ownerId, chat.chatId, chat.questionId, { context: { ...context, todos } });
  assert.deepEqual(saved.context.todos, todos);
  assert.equal(await count(db, "creative_projects"), 1);
});

test("a chat can only be saved by its own signed-in owner", async (t) => {
  const db = await database(t);
  const ownerA = await newAccount(db, 5209, "account:owner-a");
  const ownerB = await newAccount(db, 5210, "account:owner-b");
  const chatA = await ask(db, ownerA.ownerId);
  await rejection(save(db, ownerB.ownerId, chatA.chatId, chatA.questionId), "not_found");
  const projectB = await createProject(db, { ownerId: ownerB.ownerId, name: "B", context });
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [ownerA.ownerId]), 0);

  const saved = await save(db, ownerA.ownerId, chatA.chatId, chatA.questionId);
  assert.notEqual(saved.id, projectB.id);
  assert.equal((await readChat(db, ownerA.ownerId, chatA.chatId)).projectId, saved.id);
  assert.equal((await db.query("SELECT owner_id FROM creative_projects WHERE id=$1", [saved.id])).rows[0].owner_id, ownerA.ownerId);
});

test("the per-owner cap counts archived projects and holds under simultaneous saves", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5211);
  for (let index = 0; index < MAX_PROJECTS - 1; index++) {
    await db.query("INSERT INTO creative_projects(id,owner_id,name,context,revision,archived) VALUES($1,$2,'Filler',$3,1,$4)", [randomUUID(), account.ownerId, JSON.stringify({ game: "Filler" }), index % 2 === 0]);
  }
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [account.ownerId]), MAX_PROJECTS - 1);
  assert.ok(await count(db, "creative_projects", "owner_id=$1 AND archived", [account.ownerId]) > 0, "archived projects are counted");

  // Two chats saved at the same time: one fits, the other is refused at the cap.
  const first = await ask(db, account.ownerId, "First chat");
  const second = await ask(db, account.ownerId, "Second chat");
  const settled = await Promise.allSettled([
    save(db, account.ownerId, first.chatId, first.questionId),
    save(db, account.ownerId, second.chatId, second.questionId),
  ]);
  assert.deepEqual(settled.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(settled.filter((result) => result.status === "rejected")[0].reason.code, "limit");
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [account.ownerId]), MAX_PROJECTS);

  const third = await ask(db, account.ownerId, "Third chat");
  await rejection(save(db, account.ownerId, third.chatId, third.questionId), "limit");
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [account.ownerId]), MAX_PROJECTS);
});

test("a closed or stale owner cannot save", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5212);
  const chat = await ask(db, account.ownerId);
  await closeAccount(db, { id: account.id, ownerId: account.ownerId });
  await rejection(save(db, account.ownerId, chat.chatId, chat.questionId), "not_found");
  assert.equal(await count(db, "creative_projects"), 0);

  // A stale owner whose account row vanished but whose chat somehow remains.
  const stale = await newAccount(db, 5213, "account:stale-owner");
  const staleChat = await ask(db, stale.ownerId);
  await db.query("DELETE FROM accounts WHERE id=$1", [stale.id]);
  await rejection(save(db, stale.ownerId, staleChat.chatId, staleChat.questionId), "not_found");
  assert.equal(await count(db, "creative_projects"), 0);
});

test("saving a chat project writes only the project and the chat link", async (t) => {
  const db = await database(t);
  const account = await newAccount(db, 5214);
  const chat = await ask(db, account.ownerId);
  const before = { chats: await count(db, "chats"), messages: await count(db, "chat_messages") };
  const project = await save(db, account.ownerId, chat.chatId, chat.questionId, {
    context: { ...context, plan: "Ship the first loop", roadmap: [{ title: "Vertical slice", detail: "One coral bed" }], todos: [{ id: "art", text: "Draw coral", done: true }] },
  });
  assert.equal(project.context.plan, "Ship the first loop");
  assert.equal(project.context.roadmap[0].title, "Vertical slice");
  assert.equal(project.context.todos[0].done, true);

  // Nothing is reserved, queued, published or shared by saving context.
  for (const [table, where, values] of [
    ["creative_jobs", "owner_id=$1", [account.ownerId]],
    ["creative_workflows", "owner_id=$1", [account.ownerId]],
    ["creative_assets", "owner_id=$1", [account.ownerId]],
    ["credits_accounts", "owner_id=$1", [account.ownerId]],
    ["credits_operations", "owner_id=$1", [account.ownerId]],
    ["credits_ledger", "owner_id=$1", [account.ownerId]],
    ["usage_holds", "owner_id=$1", [account.ownerId]],
    ["usage_charges", "owner_id=$1", [account.ownerId]],
    ["ui_library_entries", "owner_id=$1 AND state='shared'", [account.ownerId]],
    ["linked_games", "share", []],
  ]) {
    assert.equal(await count(db, table, where, values), 0, table);
  }
  assert.equal(await count(db, "chats"), before.chats);
  assert.equal(await count(db, "chat_messages"), before.messages);
  const row = (await db.query("SELECT context FROM creative_projects WHERE id=$1", [project.id])).rows[0];
  assert.deepEqual(row.context, project.context);
});
