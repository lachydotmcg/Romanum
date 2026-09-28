import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject } from "../src/lib/projects/store.ts";
import { readProjectPlan, listProjectPlans } from "../src/lib/projects/plans.ts";
import { projectChatTools } from "../src/lib/projects/chat-tools.ts";
import { planResponse } from "../src/lib/projects/plan-http.ts";
import { planMarkdown } from "../src/lib/projects/plan-export.ts";
import { saveQuestion, saveAnswer, readChat, modelConversation, questionForModel } from "../src/lib/chats/store.ts";
import { withProjectContext } from "../src/lib/projects/chat-context.ts";
import { runAssistant } from "../src/lib/assistant/engine.ts";
import { TOOLS, prepareCall } from "../src/lib/assistant/tools.ts";
import { PUBLIC_TOOLS } from "../src/lib/public-tools.ts";
import { applyEvent, newTurn } from "../src/components/assistant/turns.ts";

const input = { title: "Reef thumbnail", kind: "thumbnail", brief: { goal: "Communicate cooperative reef restoration", truthfulContent: "Players grow coral together", visualDirection: "One coral in the foreground and a reef behind it", avoid: ["Fake rewards"] }, concepts: [{ key: "coral", title: "One small coral", hypothesis: "A clear transformation may communicate the loop", prompt: "Two players plant coral together. Leave the upper right clear.", assets: [] }] };
const ownerId = "account:planner";
async function fixture(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const project = await createProject(db, { ownerId, name: "Reef", context: { game: "Reef", gameplay: "Grow coral together" } });
  const question = await saveQuestion(db, { ownerId, projectId: project.id, chatId: null, question: "Save a thumbnail plan", attachments: [] });
  const scope = { ownerId, projectId: project.id, projectRevision: project.revision, chatId: question.chatId, questionId: question.questionId, archived: false };
  return { db, project, question, scope };
}
const call = (name, args) => prepareCall(name, JSON.stringify(args));

test("project plan tools carry server identity, reject extra permissions, and scope provider IDs per question", async (t) => {
  const { db, project, scope } = await fixture(t);
  const tools = projectChatTools(db, scope, new AbortController().signal);
  for (const key of ["ownerId", "projectId", "creditBudget", "allowAgentReview"]) {
    assert.equal((await tools.execute(call("save_asset_plan", { ...input, [key]: "injected" }), key)).ok, false);
  }
  const first = await tools.execute(call("save_asset_plan", input), "call_0");
  assert.equal(first.ok, true);
  assert.equal(first.plan.kind, "thumbnail");
  assert.equal(first.result.generationStarted, false);
  assert.deepEqual(await tools.execute(call("save_asset_plan", input), "call_0"), first);
  const nextQuestion = projectChatTools(db, { ...scope, questionId: crypto.randomUUID() }, new AbortController().signal);
  const second = await nextQuestion.execute(call("save_asset_plan", input), "call_0");
  assert.notEqual(second.plan.id, first.plan.id);
  assert.equal((await listProjectPlans(db, ownerId, project.id)).length, 2);
  const otherProject = await createProject(db, { ownerId, name: "Other", context: { game: "Other" } });
  const reader = projectChatTools(db, { ...scope, projectId: otherProject.id }, new AbortController().signal);
  assert.equal((await reader.execute(call("read_asset_plan", { planId: first.plan.id }), "read")).ok, false);
  const listed = await tools.execute(call("list_asset_plans", {}), "list");
  assert.equal(listed.result.plans.length, 2);
  const read = await tools.execute(call("read_asset_plan", { planId: first.plan.id }), "read");
  assert.equal(read.result.plan.brief.truthfulContent, input.brief.truthfulContent);
});

test("archived and cancelled scopes cannot save; one question has a bounded number of writes", async (t) => {
  const { db, project, scope } = await fixture(t);
  const archived = projectChatTools(db, { ...scope, archived: true }, new AbortController().signal);
  assert.ok(!archived.definitions.some((tool) => tool.function.name === "save_asset_plan"));
  assert.equal((await archived.execute(call("save_asset_plan", input), "archive")).ok, false);
  const cancelled = projectChatTools(db, scope, AbortSignal.abort());
  assert.equal((await cancelled.execute(call("save_asset_plan", input), "stop")).ok, false);
  assert.deepEqual(await listProjectPlans(db, ownerId, project.id), []);
  const tools = projectChatTools(db, scope, new AbortController().signal);
  for (let index = 0; index < 3; index++) assert.equal((await tools.execute(call("save_asset_plan", input), `call_${index}`)).ok, true);
  assert.equal((await tools.execute(call("save_asset_plan", input), "call_3")).ok, false);
  assert.equal((await listProjectPlans(db, ownerId, project.id)).length, 3);
});

function modelFixture(onRequest) {
  const requests = []; let number = 0;
  const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 };
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request); onRequest?.(request);
    assert.equal(request.stream, true);
    const first = number++ === 0;
    return (async function* () {
      if (first) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "save_asset_plan", arguments: JSON.stringify(input) } }] } }] };
      else yield { choices: [{ delta: { content: "Your written plan is saved." } }] };
      yield { choices: [], usage };
    })();
  } } } };
  const charges = [];
  const billing = { credits: 0, reserve: async (quote) => { charges.push(["reserve", quote]); return crypto.randomUUID(); }, settle: async () => { charges.push(["settle"]); }, finish: async () => assert.fail("complete mock calls must settle"), tool: async (_, execute) => execute() };
  return { client, billing, requests, charges };
}

test("the assistant saves a real plan through its tool loop, bills model steps and replays the plan card", async (t) => {
  const { db, project, question, scope } = await fixture(t);
  const controller = new AbortController();
  const tools = projectChatTools(db, scope, controller.signal);
  const model = modelFixture(); const events = [];
  const message = questionForModel(question.question, []);
  await runAssistant({ client: model.client, billing: model.billing, conversation: withProjectContext(modelConversation([], message), question.project), signal: controller.signal, send: (event) => events.push(event), projectTools: tools });
  const planEvent = events.find((event) => event.type === "asset_plan");
  assert.ok(planEvent);
  assert.equal((await readProjectPlan(db, ownerId, project.id, planEvent.plan.id)).title, input.title);
  assert.ok(model.requests[0].tools.some((tool) => tool.function.name === "save_asset_plan"));
  assert.equal(JSON.parse(model.requests[1].messages.findLast((entry) => entry.role === "tool").content).generationStarted, false);
  assert.deepEqual(model.charges.map(([kind]) => kind), ["reserve", "settle", "reserve", "settle"]);
  const done = events.find((event) => event.type === "done");
  await saveAnswer(db, { ownerId, chatId: question.chatId, question: message, turn: done.messages, events: events.map((e, t) => ({ t, e })) });
  const saved = await readChat(db, ownerId, question.chatId);
  let turn = newTurn("replay", question.question);
  for (const { t, e } of saved.messages[1].events) turn = applyEvent(turn, e, t);
  assert.equal(turn.plans[0].id, planEvent.plan.id);
  assert.equal(applyEvent(turn, planEvent, 99).plans.length, 1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_jobs")).rows[0].count, 0);
});

test("ordinary Ask/Chats and public MCP do not expose or execute private plan tools", async () => {
  assert.ok(!TOOLS.some((tool) => tool.function.name === "save_asset_plan"));
  assert.ok(!("save_asset_plan" in PUBLIC_TOOLS));
  const model = modelFixture(); const events = [];
  await runAssistant({ client: model.client, billing: model.billing, conversation: [{ role: "user", content: "Save to someone else's project" }], signal: new AbortController().signal, send: (event) => events.push(event) });
  assert.ok(!events.some((event) => event.type === "asset_plan"));
  assert.equal(events.find((event) => event.type === "tool_end").ok, false);
  assert.equal(JSON.parse(model.requests[1].messages.findLast((entry) => entry.role === "tool").content).error, "Unknown tool.");
});

test("plan downloads are account-private, uncached, and preserve text without active Markdown images", async (t) => {
  const { db, project, scope } = await fixture(t);
  const tools = projectChatTools(db, scope, new AbortController().signal);
  const saved = await tools.execute(call("save_asset_plan", { ...input, title: '<img src="https://example.test/tracker">', concepts: [{ ...input.concepts[0], prompt: "![track](https://example.test/image)\n<script>alert(1)</script>" }] }), "export");
  const request = new Request("https://romanum.test/api/projects/plan?download=markdown");
  const deps = { account: async () => ({ ownerId }), database: async () => db };
  const response = await planResponse(request, deps, project.id, saved.plan.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="romanum-plan-[a-f0-9-]+\.md"$/);
  const markdown = await response.text();
  assert.ok(markdown.includes("Written plan")); assert.ok(markdown.includes("Creative hypothesis"));
  assert.ok(!markdown.includes("<script>")); assert.ok(!markdown.includes("![track]("));
  assert.equal(markdown, planMarkdown(await readProjectPlan(db, ownerId, project.id, saved.plan.id)));
  assert.equal((await planResponse(request, { ...deps, account: async () => null }, project.id, saved.plan.id)).status, 401);
  assert.equal((await planResponse(request, { ...deps, account: async () => ({ ownerId: "account:other" }) }, project.id, saved.plan.id)).status, 404);
});
