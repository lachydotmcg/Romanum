import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { withReferenceImages } from "../src/lib/chats/vision.ts";
import {
  ChatError,
  chatTitle,
  deleteChat,
  imageType,
  listChats,
  modelConversation,
  questionForModel,
  readAttachment,
  readChat,
  recentHistory,
  recordEvent,
  saveAnswer,
  saveQuestion,
} from "../src/lib/chats/store.ts";

// Chats run on the application's PostgreSQL schema in an isolated in-memory database.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", "009_chats.sql"), "utf8"));
  return db;
}

const fixture = () => sharp({ create: { width: 20, height: 10, channels: 4, background: "red" } });
const png = await fixture().png().toBuffer();
const jpeg = await fixture().jpeg().toBuffer();
const webp = await fixture().webp().toBuffer();
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a ChatError"), (thrown) => thrown);
  assert.ok(error instanceof ChatError, `expected ChatError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
};

test("attachments are recognised as PNG, JPEG or WebP by their bytes, and nothing else", () => {
  assert.equal(imageType(png), "image/png");
  assert.equal(imageType(jpeg), "image/jpeg");
  assert.equal(imageType(webp), "image/webp");
  for (const bytes of ["<svg onload=alert(1)></svg>", "<html></html>", "GIF89a......", ""]) assert.equal(imageType(Buffer.from(bytes)), null);
});

test("a first question starts a chat titled after it, with its images stored privately", async (t) => {
  const db = await database(t);
  const question = "Make a thumbnail for my obby where players race over lava and dodge falling blocks";
  const saved = await saveQuestion(db, { ownerId: "guest:a", chatId: null, question: `  ${question}  `, attachments: [{ name: "C:\\refs\\lava.png", bytes: png }, { name: "blocks.jpg", bytes: jpeg }] });
  assert.deepEqual(saved.history, []);
  assert.deepEqual(saved.attachments.map((file) => file.name), ["lava.png", "blocks.jpg"]);

  const [summary] = await listChats(db, "guest:a");
  assert.equal(summary.id, saved.chatId);
  assert.equal(summary.title, chatTitle(question));
  assert.ok(summary.title.endsWith("…") && summary.title.length <= 60);

  const chat = await readChat(db, "guest:a", saved.chatId);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].content, question);
  assert.deepEqual(chat.messages[0].attachments, saved.attachments);
  const file = await readAttachment(db, "guest:a", saved.attachments[0].id);
  assert.equal(file.mimeType, "image/webp");
  assert.equal((await sharp(file.bytes).metadata()).format, "webp");
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(saved.images[0].bytes));

  // Another guest can't see the chat, its images or add to it.
  assert.deepEqual(await listChats(db, "guest:b"), []);
  assert.equal(await readChat(db, "guest:b", saved.chatId), null);
  assert.equal(await readAttachment(db, "guest:b", saved.attachments[0].id), null);
  await rejection(saveQuestion(db, { ownerId: "guest:b", chatId: saved.chatId, question: "Hi", attachments: [] }), "not_found");
  assert.equal(await deleteChat(db, "guest:b", saved.chatId), false);
});

test("questions and attachments outside the limits are refused before anything is stored", async (t) => {
  const db = await database(t);
  const ask = (overrides) => saveQuestion(db, { ownerId: "guest:a", chatId: null, question: "Hi", attachments: [], ...overrides });
  await rejection(ask({ question: "   " }), "invalid_input");
  await rejection(ask({ question: "x".repeat(4001) }), "invalid_input");
  await rejection(ask({ attachments: Array.from({ length: 4 }, (_, index) => ({ name: `${index}.png`, bytes: png })) }), "invalid_input");
  await rejection(ask({ attachments: [{ name: "logo.svg", bytes: Buffer.from("<svg></svg>") }] }), "invalid_input");
  await rejection(ask({ attachments: [{ name: "broken.png", bytes: png.subarray(0, 24) }] }), "invalid_input");
  await rejection(ask({ attachments: [{ name: "huge.png", bytes: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]) }] }), "invalid_input");
  await rejection(ask({ chatId: "not-a-chat" }), "not_found");
  await rejection(ask({ chatId: crypto.randomUUID() }), "not_found");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM chats")).rows[0].count, 0);
});

test("inline image inputs never enter saved model history or replayed events", async (t) => {
  const db = await database(t);
  const first = await saveQuestion(db, { ownerId: "guest:a", chatId: null, question: "Review this UI", attachments: [{ name: "ui.png", bytes: png }] });
  const question = questionForModel(first.question, first.attachments.map((file) => file.name));
  const vision = withReferenceImages(question, first.images);
  assert.equal(vision.content[1].type, "image_url");
  await saveAnswer(db, { ownerId: "guest:a", chatId: first.chatId, question: vision, turn: [{ role: "assistant", content: "The red panel is small." }], events: [] });
  const { rows } = await db.query("SELECT history FROM chats WHERE id=$1", [first.chatId]);
  assert.equal(rows[0].history[0].content, question.content);
  assert.ok(!JSON.stringify(rows).includes("base64"));
  const replay = await readChat(db, "guest:a", first.chatId);
  assert.ok(!JSON.stringify(replay).includes("base64"));
  assert.equal(await readChat(db, "guest:b", first.chatId), null);
});

test("answers are saved with the history the next question needs, and an unfinished answer keeps only its question", async (t) => {
  const db = await database(t);
  const first = await saveQuestion(db, { ownerId: "guest:a", chatId: null, question: "Top games?", attachments: [] });
  const question = questionForModel(first.question, []);
  const turn = [
    { role: "assistant", content: "", reasoning_content: "Look it up.", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_chart", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{}" },
    { role: "assistant", content: "Here they are.", reasoning_content: "" },
  ];
  await saveAnswer(db, { ownerId: "guest:a", chatId: first.chatId, question, turn, events: [{ t: 0, e: { type: "text", delta: "Here they are." } }, { t: 5, e: { type: "done", messages: [] } }] });

  const second = await saveQuestion(db, { ownerId: "guest:a", chatId: first.chatId, question: "And the second?", attachments: [{ name: "ref.webp", bytes: webp }] });
  assert.deepEqual(second.history, [question, ...turn]);
  const next = questionForModel(second.question, second.attachments.map((file) => file.name));
  assert.equal(next.content, "And the second?\n\n[Attached reference images: ref.webp]");
  await saveAnswer(db, { ownerId: "guest:a", chatId: first.chatId, question: next, turn: null, events: [{ t: 0, e: { type: "error", message: "Stopped." } }] });

  const chat = await readChat(db, "guest:a", first.chatId);
  assert.deepEqual(chat.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(chat.messages[1].events[0].e.delta, "Here they are.");
  const { rows } = await db.query("SELECT history FROM chats WHERE id=$1", [first.chatId]);
  assert.deepEqual(rows[0].history, [question, ...turn, next]);

  assert.equal(await deleteChat(db, "guest:a", first.chatId), true);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM chat_attachments")).rows[0].count, 0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM chat_messages")).rows[0].count, 0);
});

test("recorded answers merge streamed chunks and drop what the transcript doesn't draw", () => {
  const events = [];
  recordEvent(events, { type: "thinking", delta: "Let me " }, 0);
  recordEvent(events, { type: "thinking", delta: "check." }, 40);
  recordEvent(events, { type: "tool_start", id: "1", label: "Chart", activity: "Reading", detail: "", input: {} }, 900);
  recordEvent(events, { type: "text", delta: "Steal " }, 1500);
  recordEvent(events, { type: "text", delta: "An Egg." }, 1520);
  recordEvent(events, { type: "done", messages: [{ role: "assistant", content: "Steal An Egg." }] }, 1600);
  recordEvent(events, { type: "suggestion", text: "Why?" }, 2000);
  assert.deepEqual(events.map(({ t, e }) => [t, e.type, e.delta ?? e.messages?.length ?? ""]), [
    [0, "thinking", "Let me check."],
    [900, "tool_start", ""],
    [1500, "text", "Steal An Egg."],
    [1600, "done", 0],
  ]);
});

test("the model gets the latest history from a question onward, so tool calls keep their results", () => {
  const history = [
    { role: "user", content: "a" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: "{}" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
  ];
  assert.deepEqual(recentHistory(history, 3).map((message) => message.content), ["c", "d"]);
  assert.deepEqual(recentHistory(history, 10), history);
  assert.equal(modelConversation(history, { role: "user", content: "e" }).at(-1).content, "e");
});
