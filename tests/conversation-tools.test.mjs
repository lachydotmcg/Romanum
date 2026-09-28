import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { conversationTools } from "../src/lib/projects/conversation-tools.ts";
import { saveChatProjectContext } from "../src/lib/projects/conversation-context.ts";
import { readProject, updateProject } from "../src/lib/projects/store.ts";
import { saveQuestion, saveAnswer, readChat, questionForModel, recordEvent } from "../src/lib/chats/store.ts";
import { withProjectContext } from "../src/lib/projects/chat-context.ts";
import { prepareCall, TOOLS } from "../src/lib/assistant/tools.ts";
import { PUBLIC_TOOLS } from "../src/lib/public-tools.ts";
import { runAssistant } from "../src/lib/assistant/engine.ts";
import { newTurn, applyEvent } from "../src/components/assistant/turns.ts";

const context = { game: "Reef Workshop", gameplay: "Plant and restore coral", audience: "", artDirection: "Flat", constraints: ["Solo developer"], plan: "Start with one coral bed and one harvest cycle.", roadmap: [{ title: "Prototype", detail: "Build planting and harvesting." }], todos: [{ id: "planting", text: "Build planting", done: false }] };
const input = { name: context.game, context, expectedRevision: 0 };
const plan = { kind: "ui", title: "Inventory", brief: { goal: "Select coral", truthfulContent: "Shows owned coral", visualDirection: "Flat", avoid: [] }, concepts: [{ key: "tray", title: "Tray", hypothesis: "Clear selection", prompt: "One tray of coral", assets: [{ key: "tray", label: "Tray", prompt: "Empty panel", size: "1024x1024" }] }] };
const call = (name, data) => prepareCall(name, JSON.stringify(data));
async function setup(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const accountId = randomUUID(), ownerId = `account:${accountId}`;
  await db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,7811,'fixture','Fixture')", [accountId, ownerId]);
  const question = await saveQuestion(db, { ownerId, chatId: null, question: "Plan Reef Workshop and save our agreed plan, roadmap and tasks", attachments: [] });
  const scope = { ownerId, chatId: question.chatId, questionId: question.questionId, project: null };
  return { db, ownerId, question, scope, tools: conversationTools(db, scope, new AbortController().signal) };
}

test("signed-in chat tools save context in the model loop, then unlock asset plans and retain the same conversation", async t => {
  const { db, scope, tools, question, ownerId } = await setup(t);
  const requests = [], charges = [], events = []; let step = 0;
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    if (!request.stream) return { choices: [{ message: { content: "What should we prototype first?" } }], usage };
    const index = step++;
    return (async function* () {
      const action = index === 0 ? ["save_project_context", input] : index === 1 ? ["save_asset_plan", plan] : null;
      yield { choices: [{ delta: action ? { tool_calls: [{ index: 0, id: `call-${index}`, function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { content: "Saved the game plan and inventory concept." } }] };
      yield { choices: [], usage };
    })();
  } } } };
  const billing = { credits: 0, reserve: async () => { charges.push("reserve"); return randomUUID(); }, settle: async () => charges.push("settle"), finish: async () => assert.fail("mock calls complete") };
  await runAssistant({ client, billing, conversation: [questionForModel(question.question, [])], send: e => events.push(e), signal: new AbortController().signal, projectTools: tools });
  const saved = events.find(e => e.type === "project_context"); assert.ok(saved);
  assert.equal(saved.project.context.todos[0].done, false);
  assert.equal(events.find(e => e.type === "asset_plan").plan.projectId, saved.project.id);
  assert.ok(!requests[0].tools.some(tool => tool.function.name === "save_asset_plan"));
  assert.ok(requests[1].tools.some(tool => tool.function.name === "save_asset_plan"));
  assert.equal(charges.length, 8);
  const timed = []; events.forEach((e, index) => recordEvent(timed, e, index));
  await saveAnswer(db, { ownerId, chatId: question.chatId, question: questionForModel(question.question, []), turn: events.find(e => e.type === "done").messages, events: timed });
  const chat = await readChat(db, ownerId, question.chatId); assert.equal(chat.projectId, saved.project.id); assert.equal(chat.messages.length, 2);
  let turn = newTurn("replay", question.question); for (const { t, e } of chat.messages[1].events) turn = applyEvent(turn, e, t);
  assert.equal(turn.done, true); assert.equal(turn.plans.length, 1);
  const next = await saveQuestion(db, { ownerId, chatId: question.chatId, question: "What next?", attachments: [] });
  assert.match(withProjectContext([questionForModel(next.question, [])], next.project)[0].content, /Build planting/);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_jobs")).rows[0].count, 0);
  assert.equal(scope.chatId, chat.id);
});

test("context tooling rejects injected scope, stops on cancellation and limits saves without changing accounts", async t => {
  const { db, scope, tools } = await setup(t);
  assert.ok(!TOOLS.some(tool => tool.function.name === "save_project_context")); assert.ok(!("save_project_context" in PUBLIC_TOOLS));
  for (const extra of [{ ownerId: "another" }, { projectId: randomUUID() }, { chatId: randomUUID() }]) assert.equal((await tools.execute(call("save_project_context", { ...input, ...extra }), "bad")).ok, false);
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await conversationTools(db, scope, stopped.signal).execute(call("save_project_context", input), "stop")).ok, false);
  const saved = await tools.execute(call("save_project_context", input), "first"); assert.equal(saved.ok, true);
  assert.equal((await tools.execute(call("save_project_context", { ...input, expectedRevision: 1, name: "Second" }), "second")).ok, false);
  assert.equal((await readProject(db, scope.ownerId, saved.project.id)).name, input.name);
});

test("manual checklist edits survive omission by the model, and a stale model cannot overwrite a newer revision", async t => {
  const { db, scope, ownerId } = await setup(t);
  const first = await saveChatProjectContext(db, { ...input, ownerId, chatId: scope.chatId, questionId: scope.questionId });
  const checked = await updateProject(db, { ownerId, id: first.id, name: first.name, revision: first.revision, archived: false, context: { ...context, todos: [{ ...context.todos[0], done: true }] } });
  const next = await saveQuestion(db, { ownerId, chatId: scope.chatId, question: "Change the core loop", attachments: [] });
  const content = { ...context, gameplay: "Explore and plant coral" }; delete content.plan; delete content.roadmap; delete content.todos;
  await assert.rejects(saveChatProjectContext(db, { ...input, ownerId, chatId: scope.chatId, questionId: next.questionId, expectedRevision: 1, context: content }), { code: "conflict" });
  const saved = await saveChatProjectContext(db, { ...input, ownerId, chatId: scope.chatId, questionId: next.questionId, expectedRevision: checked.revision, context: content });
  assert.equal(saved.context.todos[0].done, true); assert.equal(saved.context.plan, context.plan); assert.deepEqual(saved.context.roadmap, context.roadmap);
  await assert.rejects(updateProject(db, { ownerId, id: saved.id, name: saved.name, revision: saved.revision, archived: false, context: { ...context, todos: [context.todos[0], context.todos[0]] } }), { code: "invalid_input" });
});
