import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject, updateProject } from "../src/lib/projects/store.ts";
import { deleteChat, saveQuestion } from "../src/lib/chats/store.ts";
import { createCreativeWorkflow, queueCreativeJob } from "../src/lib/creative/workflow.ts";
import {
  MAX_PLANS,
  PlanError,
  createProjectPlan,
  listProjectPlans,
  planInputSchema,
  readProjectPlan,
} from "../src/lib/projects/plans.ts";

// Written asset plans run on the application schema in an isolated in-memory
// database, migrated in full. Every game, chat and plan here is invented test
// data, and no provider is called and no image is generated.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

const actor = "account:a";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const context = { game: "Reef tycoon", gameplay: "Grow and trade corals", audience: "Families", artDirection: "Soft flat shapes", constraints: ["Readable on mobile"] };
const brief = { goal: "Show the first coral", truthfulContent: "Coral planting is available", visualDirection: "One clear action", avoid: ["Fake rewards"] };
const concept = { key: "coral", title: "First coral", hypothesis: "One action may read clearly", prompt: "A hand planting a coral", assets: [] };
const uiConcept = { ...concept, assets: [{ key: "panel", label: "Grow panel", prompt: "A growth panel", size: "1024x1024" }] };
const provider = (generate) => ({ id: "test-only", model: "fixture", mode: "test", available: true, generate: generate ?? (async () => ({ bytes: png, mimeType: "image/png" })) });
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a PlanError"), (thrown) => thrown);
  assert.ok(error instanceof PlanError, `expected PlanError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};
// now() is read from the clock, so a short pause keeps created ordering distinct.
const pause = () => new Promise((resolve) => setTimeout(resolve, 8));

const draft = { ownerId: actor, name: "Reef", context };
const chatFor = (db, projectId, question = "Write a plan") => saveQuestion(db, { ownerId: actor, chatId: null, projectId, question, attachments: [] });
const callFor = (projectId, chatId, overrides = {}) => ({
  ownerId: actor, projectId, chatId, callId: randomUUID(), projectRevision: 1,
  input: { title: "Coral launch", kind: "thumbnail", brief, concepts: [concept] }, ...overrides,
});

test("the plan schema is strict and enforces kind semantics", () => {
  const thumbnail = { title: "  Coral launch  ", kind: "thumbnail", brief, concepts: [concept] };
  const parsed = planInputSchema.parse(thumbnail);
  assert.equal(parsed.title, "Coral launch", "the title is trimmed");
  assert.equal(planInputSchema.safeParse({ ...thumbnail, kind: "ui" }).success, false, "a UI plan needs assets");
  assert.equal(planInputSchema.parse({ ...thumbnail, kind: "ui", concepts: [uiConcept] }).concepts[0].assets.length, 1);
  assert.equal(planInputSchema.safeParse({ ...thumbnail, concepts: [uiConcept] }).success, false, "a thumbnail plan lists no assets");
  assert.equal(planInputSchema.safeParse({ ...thumbnail, concepts: [] }).success, false);
  assert.equal(planInputSchema.safeParse({ ...thumbnail, title: "   " }).success, false);
  assert.equal(planInputSchema.safeParse({ ...thumbnail, title: "t".repeat(101) }).success, false);
  assert.equal(planInputSchema.safeParse({ title: "No kind", brief, concepts: [concept] }).success, false);
  assert.equal(planInputSchema.safeParse({ ...thumbnail, brief: { ...brief, extra: "x" } }).success, false);
  assert.equal(planInputSchema.safeParse({ ...thumbnail, concepts: [concept, { ...concept, assets: [] }] }).success, false, "concept keys stay unique");
  // Identity, budget and permissions are supplied by the server, never the model.
  for (const injected of [{ ownerId: "attacker" }, { creditBudget: 10 }, { allowAgentReview: true }, { sourceChatId: randomUUID() }, { projectRevision: 2 }, { extra: 1 }]) {
    assert.equal(planInputSchema.safeParse({ ...thumbnail, ...injected }).success, false, JSON.stringify(injected));
  }
});

test("plans are saved, read and listed within one owner and project", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const first = await createProjectPlan(db, callFor(project.id, chat.chatId, { input: { title: "Coral launch", kind: "thumbnail", brief, concepts: [concept] } }));
  assert.deepEqual(Object.keys(first).sort(), ["brief", "concepts", "createdAt", "id", "kind", "projectContext", "projectId", "projectRevision", "sourceChatId", "title"]);
  assert.equal(first.projectId, project.id);
  assert.equal(first.sourceChatId, chat.chatId);
  assert.equal(first.projectRevision, 1);
  assert.deepEqual(first.projectContext, context);
  assert.deepEqual(first.brief, brief);
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);

  await pause();
  const second = await createProjectPlan(db, callFor(project.id, chat.chatId, { input: { title: "Grow screen", kind: "ui", brief, concepts: [uiConcept] } }));
  assert.deepEqual(await readProjectPlan(db, actor, project.id, first.id), first);
  assert.deepEqual(await listProjectPlans(db, actor, project.id), [
    { id: second.id, projectId: project.id, title: "Grow screen", kind: "ui", conceptCount: 1, createdAt: second.createdAt },
    { id: first.id, projectId: project.id, title: "Coral launch", kind: "thumbnail", conceptCount: 1, createdAt: first.createdAt },
  ]);

  // Another owner, another project and a malformed ID see nothing.
  assert.equal(await readProjectPlan(db, "account:b", project.id, first.id), null);
  assert.deepEqual(await listProjectPlans(db, "account:b", project.id), []);
  const other = await createProject(db, { ownerId: actor, name: "Other", context });
  assert.equal(await readProjectPlan(db, actor, other.id, first.id), null);
  assert.deepEqual(await listProjectPlans(db, actor, other.id), []);
  for (const id of ["not-a-uuid", "", randomUUID()]) assert.equal(await readProjectPlan(db, actor, project.id, id), null);
  assert.equal(await readProjectPlan(db, actor, "not-a-uuid", first.id), null);
  assert.deepEqual(await listProjectPlans(db, actor, "not-a-uuid"), []);
});

test("a saved plan reserves nothing: zero budget, no approval, no references, no jobs and no credits", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const saved = await createProjectPlan(db, callFor(project.id, chat.chatId));

  const { rows } = await db.query("SELECT credit_budget, allow_agent_review, approval, reference_ids, concepts FROM creative_workflows WHERE id=$1", [saved.id]);
  assert.equal(rows[0].credit_budget, 0);
  assert.equal(rows[0].allow_agent_review, false);
  assert.equal(rows[0].approval, null);
  assert.deepEqual(rows[0].reference_ids, []);
  assert.deepEqual(rows[0].concepts, [concept]);
  for (const table of ["creative_jobs", "credits_accounts", "credits_operations", "credits_ledger"]) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
});

test("a plan needs a real chat belonging to the same owner and project", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const other = await createProject(db, { ownerId: actor, name: "Other", context });
  const strangerProject = await createProject(db, { ownerId: "account:b", name: "Stranger", context });
  const otherChat = await chatFor(db, other.id);
  const strangerChat = await saveQuestion(db, { ownerId: "account:b", chatId: null, projectId: strangerProject.id, question: "Plan", attachments: [] });

  await rejection(createProjectPlan(db, callFor(project.id, randomUUID())), "not_found");
  await rejection(createProjectPlan(db, callFor(project.id, otherChat.chatId)), "not_found");
  await rejection(createProjectPlan(db, callFor(project.id, strangerChat.chatId)), "not_found");
  await rejection(createProjectPlan(db, callFor(project.id, "not-a-uuid")), "not_found");
  await rejection(createProjectPlan(db, callFor(project.id, null)), "not_found");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_workflows")).rows[0].count, 0);

  const chat = await chatFor(db, project.id);
  assert.equal((await createProjectPlan(db, callFor(project.id, chat.chatId))).sourceChatId, chat.chatId);
});

test("a new plan needs the project's exact active revision", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  await rejection(createProjectPlan(db, callFor(project.id, chat.chatId, { projectRevision: 2 })), "conflict");

  const edited = await updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Reef", context: { ...context, gameplay: "Explore sunken ships" }, archived: false });
  assert.equal(edited.revision, 2);
  await rejection(createProjectPlan(db, callFor(project.id, chat.chatId, { projectRevision: 1 })), "conflict");
  const saved = await createProjectPlan(db, callFor(project.id, chat.chatId, { projectRevision: 2 }));
  assert.equal(saved.projectRevision, 2);

  await updateProject(db, { ownerId: actor, id: project.id, revision: 2, name: "Reef", context: edited.context, archived: true });
  await rejection(createProjectPlan(db, callFor(project.id, chat.chatId, { projectRevision: 3 })), "conflict");
  // Archiving stops new plans but keeps the ones already written.
  assert.equal((await readProjectPlan(db, actor, project.id, saved.id)).id, saved.id);
  assert.deepEqual((await listProjectPlans(db, actor, project.id)).map((plan) => plan.id), [saved.id]);
});

test("an identical call replays, a changed payload conflicts, and a concurrent duplicate makes one plan", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const call = callFor(project.id, chat.chatId);

  const first = await createProjectPlan(db, call);
  assert.equal((await createProjectPlan(db, { ...call, input: { ...call.input } })).id, first.id);
  await rejection(createProjectPlan(db, { ...call, input: { ...call.input, title: "Changed" } }), "conflict");
  await rejection(createProjectPlan(db, { ...call, projectRevision: 2 }), "conflict");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_workflows")).rows[0].count, 1);

  // A replay still resolves after the project has moved on.
  const edited = await updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Reef", context: { ...context, gameplay: "Changed" }, archived: false });
  assert.equal((await createProjectPlan(db, call)).id, first.id);

  // The same call ID from another chat is a different call.
  const secondChat = await chatFor(db, project.id, "Another plan");
  const separate = await createProjectPlan(db, { ...call, chatId: secondChat.chatId, projectRevision: edited.revision });
  assert.notEqual(separate.id, first.id);
  assert.equal(separate.sourceChatId, secondChat.chatId);

  // Two simultaneous identical calls create exactly one plan.
  const race = { ...call, chatId: secondChat.chatId, callId: randomUUID(), projectRevision: edited.revision };
  const settled = await Promise.allSettled([createProjectPlan(db, race), createProjectPlan(db, race)]);
  assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(settled[0].value.id, settled[1].value.id);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_workflows WHERE source_call_id=$1", [race.callId])).rows[0].count, 1);
});

test("a project may keep at most 50 plans", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  for (let index = 0; index < MAX_PLANS; index++) {
    await createProjectPlan(db, callFor(project.id, chat.chatId, { input: { title: `Plan ${index}`, kind: "thumbnail", brief, concepts: [concept] } }));
  }
  assert.equal((await listProjectPlans(db, actor, project.id)).length, MAX_PLANS);
  await rejection(createProjectPlan(db, callFor(project.id, chat.chatId)), "limit");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_workflows WHERE project_id=$1", [project.id])).rows[0].count, MAX_PLANS);

  // The cap is per project.
  const other = await createProject(db, { ownerId: actor, name: "Other", context });
  const otherChat = await chatFor(db, other.id);
  assert.equal((await createProjectPlan(db, callFor(other.id, otherChat.chatId))).projectRevision, 1);
});

test("a plan keeps the context snapshot it was written with", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const saved = await createProjectPlan(db, callFor(project.id, chat.chatId));

  await updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Reef", context: { ...context, gameplay: "Explore sunken ships" }, archived: false });
  const read = await readProjectPlan(db, actor, project.id, saved.id);
  assert.deepEqual(read.projectContext, context);
  assert.equal(read.projectContext.gameplay, "Grow and trade corals");
  assert.equal(read.projectRevision, 1);
});

test("deleting a chat keeps its plan and clears the saved chat link", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const call = callFor(project.id, chat.chatId);
  const saved = await createProjectPlan(db, call);

  assert.equal(await deleteChat(db, actor, chat.chatId), true);
  const read = await readProjectPlan(db, actor, project.id, saved.id);
  assert.equal(read.sourceChatId, null);
  assert.deepEqual(read.concepts, saved.concepts);
  assert.deepEqual((await listProjectPlans(db, actor, project.id)).map((plan) => plan.id), [saved.id]);

  // The immutable call key still recognises the replay after the chat is gone.
  const replay = await createProjectPlan(db, call);
  assert.equal(replay.id, saved.id);
  assert.equal(replay.sourceChatId, null);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_workflows")).rows[0].count, 1);
});

test("internal workflows without plan metadata never appear as plans", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const flow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 5 });
  assert.equal(await readProjectPlan(db, actor, project.id, flow.id), null);
  assert.deepEqual(await listProjectPlans(db, actor, project.id), []);

  const chat = await chatFor(db, project.id);
  const saved = await createProjectPlan(db, callFor(project.id, chat.chatId));
  assert.deepEqual((await listProjectPlans(db, actor, project.id)).map((plan) => plan.id), [saved.id]);
  assert.equal(await readProjectPlan(db, actor, project.id, flow.id), null);
});

test("work queued against a zero-budget plan is refused and writes nothing", async (t) => {
  const db = await database(t);
  const project = await createProject(db, draft);
  const chat = await chatFor(db, project.id);
  const saved = await createProjectPlan(db, callFor(project.id, chat.chatId));

  const calls = [];
  const free = provider(async (request) => { calls.push(request); return { bytes: png, mimeType: "image/png" }; });
  const job = { ownerId: actor, workflowId: saved.id, conceptKey: "coral", stage: "concept" };
  await assert.rejects(queueCreativeJob(db, free, { ...job, jobId: randomUUID() }), (error) => error.code === "budget_exceeded");
  assert.equal(calls.length, 0);
  const paid = { ...provider(), mode: "paid", generate: async () => assert.fail("a paid provider must never be called") };
  await assert.rejects(queueCreativeJob(db, paid, { ...job, jobId: randomUUID() }), (error) => error.code === "unavailable");
  for (const table of ["creative_jobs", "credits_operations", "credits_ledger"]) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
});
