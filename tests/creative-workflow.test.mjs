import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { grantCredits, getBalance } from "../src/lib/credits/ledger.ts";
import { ImageProviderError } from "../src/lib/creative/image-provider.ts";
import { createCreativeProject, addCreativeReference, readCreativeAsset } from "../src/lib/creative/storage.ts";
import { createCreativeWorkflow, saveCreativeConcepts, queueCreativeJob, executeCreativeJob, approveCreativeConcept, readCreativeWorkflow, readCreativeJob, cancelCreativeJob, flagInterruptedCreativeJob } from "../src/lib/creative/workflow.ts";

// The tiny PNG and all game/credit data are fixtures in isolated test databases.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const context = { game: "Test garden", gameplay: "Grow and trade plants", audience: "Mixed reading abilities", artDirection: "Paper shapes", constraints: ["Readable on mobile"] };
const brief = { goal: "Show planting", truthfulContent: "Growing plants is available", visualDirection: "One clear action", avoid: ["Fake rewards"] };
const concept = { key: "planting", title: "First seed", hypothesis: "An action may read clearly", prompt: "A hand planting a seed", assets: [] };
const uiConcept = { ...concept, assets: [{ key: "panel", label: "Seed panel", prompt: "A seed tray panel", size: "1024x1024" }, { key: "seed", label: "Seed icon", prompt: "One seed icon", size: "1024x1024" }] };
const actor = "test-owner";
const provider = (generate) => ({ id: "test-only", model: "fixture", mode: "test", available: true, generate: generate ?? (async () => ({ bytes: png, mimeType: "image/png" })) });

async function setup(t, options = {}) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId: actor, name: "Test", context });
  await grantCredits(db, { ownerId: actor, operationId: randomUUID(), amount: 30 });
  const flow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: options.kind ?? "thumbnail", brief, creditBudget: options.budget ?? 20, allowAgentReview: options.allowAgentReview ?? false });
  await saveCreativeConcepts(db, actor, flow.id, [options.kind === "ui" ? uiConcept : concept]);
  const queue = (p, extra = {}) => queueCreativeJob(db, p, { ownerId: actor, workflowId: flow.id, jobId: randomUUID(), conceptKey: "planting", stage: "concept", ...extra });
  return { db, project, flow, queue };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("thumbnail goes from reviewed render to durable final output and captures each quote once", async (t) => {
  const { db, flow, queue, project } = await setup(t);
  const calls = [];
  const p = provider(async (request) => { calls.push(request); return { bytes: png, mimeType: "image/png", requestId: "req_safe" }; });
  await rejectsCode(queue(p, { stage: "final" }), "approval_required");
  const job = await queue(p);
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 1);
  const replay = await queueCreativeJob(db, p, { ownerId: actor, workflowId: flow.id, jobId: job.id, conceptKey: "planting", stage: "concept" });
  assert.equal(replay.id, job.id);
  await Promise.all([executeCreativeJob(db, p, actor, job.id), executeCreativeJob(db, p, actor, job.id)]);
  assert.equal(calls.length, 1);
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "review");
  await rejectsCode(approveCreativeConcept(db, { ownerId: actor, workflowId: flow.id, jobId: job.id, reviewer: "agent", reason: "looks good" }), "approval_required");
  await approveCreativeConcept(db, { ownerId: actor, workflowId: flow.id, jobId: job.id, reviewer: "owner", reason: "Composition reviewed" });
  const final = await queue(p, { stage: "final" });
  const finished = await executeCreativeJob(db, p, actor, final.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(calls[1].references.length, 1);
  assert.deepEqual(Buffer.from(calls[1].references[0].bytes), png);
  assert.equal(calls[1].transparent, false);
  const asset = await readCreativeAsset(db, actor, project.id, finished.output_asset_id);
  assert.equal(asset.metadata.mode, "test");
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "assets_ready");
  assert.deepEqual(await getBalance(db, { ownerId: actor }), { ownerId: actor, balance: 27, reserved: 0, available: 27 });
  await executeCreativeJob(db, p, actor, final.id);
  assert.equal(calls.length, 2);
});

test("UI assets require the approved concept and produce transparent individual files", async (t) => {
  const { db, flow, queue } = await setup(t, { kind: "ui", allowAgentReview: true });
  const calls = [];
  const p = provider(async (request) => { calls.push(request); return { bytes: png, mimeType: "image/png" }; });
  await rejectsCode(queue(p, { stage: "asset", assetKey: "panel" }), "approval_required");
  const preview = await queue(p);
  await executeCreativeJob(db, p, actor, preview.id);
  await approveCreativeConcept(db, { ownerId: actor, workflowId: flow.id, jobId: preview.id, reviewer: "agent", reason: "Delegated review completed" });
  await rejectsCode(queue(p, { stage: "asset", assetKey: "unplanned" }), "not_found");
  for (const assetKey of ["panel", "seed"]) {
    const assetJob = await queue(p, { stage: "asset", assetKey });
    await executeCreativeJob(db, p, actor, assetJob.id);
  }
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "assets_ready");
  assert.ok(calls.slice(1).every((call) => call.transparent && call.references.length === 1 && call.prompt.includes("editable Roblox UI")));
});

test("paid or disabled providers cannot reserve credits or make requests", async (t) => {
  const { db, queue } = await setup(t);
  for (const p of [{ ...provider(), available: false }, { ...provider(), mode: "paid" }]) {
    p.generate = async () => assert.fail("paid/disabled provider called");
    await rejectsCode(queue(p), "unavailable");
  }
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_jobs")).rows[0].count, 0);
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 0);
});

test("failure releases credits while uncertain outcomes retain the hold and never auto-retry", async (t) => {
  const { db, queue } = await setup(t);
  const rejected = provider(async () => { throw new ImageProviderError("rejected"); });
  const first = await queue(rejected);
  assert.equal((await executeCreativeJob(db, rejected, actor, first.id)).status, "failed");
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 0);
  let calls = 0;
  const uncertain = provider(async () => { calls++; throw new Error("private response or key must not persist"); });
  const second = await queue(uncertain);
  assert.equal((await executeCreativeJob(db, uncertain, actor, second.id)).status, "uncertain");
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 1);
  const again = await executeCreativeJob(db, uncertain, actor, second.id);
  assert.equal(calls, 1);
  assert.equal(again.error_code, "reconciliation_required");
  await rejectsCode(cancelCreativeJob(db, actor, second.id), "conflict");
  await rejectsCode(queue(uncertain), "conflict");
});

test("workflow budget and idempotency conflicts do not leak holds", async (t) => {
  const { db, flow, queue } = await setup(t, { budget: 1 });
  const p = provider();
  const job = await queue(p);
  await rejectsCode(queueCreativeJob(db, p, { ownerId: actor, workflowId: flow.id, jobId: job.id, conceptKey: "planting", stage: "final" }), "conflict");
  await executeCreativeJob(db, p, actor, job.id);
  await approveCreativeConcept(db, { ownerId: actor, workflowId: flow.id, jobId: job.id, reviewer: "owner", reason: "Reviewed" });
  await rejectsCode(queue(p, { stage: "final" }), "budget_exceeded");
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 0);
});

test("cancelling queued work releases once, and changed providers cannot execute it", async (t) => {
  const { db, queue } = await setup(t);
  const p = provider();
  const job = await queue(p);
  await rejectsCode(executeCreativeJob(db, { ...p, model: "different" }, actor, job.id), "conflict");
  await cancelCreativeJob(db, actor, job.id);
  await cancelCreativeJob(db, actor, job.id);
  assert.equal((await getBalance(db, { ownerId: actor })).available, 30);
  assert.equal((await executeCreativeJob(db, p, actor, job.id)).status, "cancelled");
});

test("private projects, references, workflows and outputs cannot cross owner or project boundaries", async (t) => {
  const { db, project, flow, queue } = await setup(t);
  await rejectsCode(readCreativeWorkflow(db, "other-owner", flow.id), "not_found");
  await rejectsCode(createCreativeWorkflow(db, { ownerId: "other-owner", projectId: project.id, kind: "thumbnail", brief, creditBudget: 5 }), "not_found");
  const id = await addCreativeReference(db, { ownerId: actor, projectId: project.id, bytes: png, metadata: { label: "Owned reference", rights: "owned", rightsNote: "Original source", performance: { metric: "click_through_rate", impressions: 100, outcomes: 2, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", source: "Developer export", cohort: "Test campaign" } } });
  const ref = await readCreativeAsset(db, actor, project.id, id);
  assert.equal(ref.metadata.performance.outcomes, 2);
  assert.equal(ref.metadata.ctr, undefined);
  await rejectsCode(readCreativeAsset(db, "other-owner", project.id, id), "not_found");
  const otherProject = await createCreativeProject(db, { ownerId: actor, name: "Other", context });
  await rejectsCode(createCreativeWorkflow(db, { ownerId: actor, projectId: otherProject.id, kind: "thumbnail", brief, referenceIds: [id], creditBudget: 5 }), "not_found");
  const job = await queue(provider());
  await rejectsCode(executeCreativeJob(db, provider(), "other-owner", job.id), "not_found");
  await rejectsCode(readCreativeJob(db, "other-owner", job.id), "not_found");
});

test("invalid reference rights, performance denominators and image bytes never enter storage", async (t) => {
  const { db, project } = await setup(t);
  const input = { ownerId: actor, projectId: project.id, bytes: png, metadata: { label: "Reference", rights: "owned", rightsNote: "Original" } };
  await assert.rejects(addCreativeReference(db, { ...input, metadata: { ...input.metadata, rights: "unknown" } }));
  await assert.rejects(addCreativeReference(db, { ...input, bytes: Buffer.from("<script>alert('x')</script>") }));
  await assert.rejects(addCreativeReference(db, { ...input, metadata: { ...input.metadata, performance: { metric: "click_through_rate", impressions: 10, outcomes: 11, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", source: "Export", cohort: "Test" } } }));
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_assets")).rows[0].count, 0);
});

test("concepts freeze when jobs begin and approval requires this workflow's successful render", async (t) => {
  const { db, project, flow, queue } = await setup(t);
  const p = provider();
  const job = await queue(p);
  await rejectsCode(saveCreativeConcepts(db, actor, flow.id, [{ ...concept, prompt: "Changed after queuing" }]), "conflict");
  await rejectsCode(approveCreativeConcept(db, { ownerId: actor, workflowId: flow.id, jobId: job.id, reviewer: "owner", reason: "Unrendered" }), "approval_required");
  await executeCreativeJob(db, p, actor, job.id);
  const other = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 2 });
  await rejectsCode(approveCreativeConcept(db, { ownerId: actor, workflowId: other.id, jobId: job.id, reviewer: "owner", reason: "Wrong flow" }), "approval_required");
});

test("output storage failure rolls back capture and is marked uncertain", async (t) => {
  const { db, queue } = await setup(t);
  const job = await queue(provider());
  await db.exec("CREATE FUNCTION fail_output_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outage'; END; $$; CREATE TRIGGER fail_output_test BEFORE INSERT ON creative_assets FOR EACH ROW EXECUTE FUNCTION fail_output_test();");
  const result = await executeCreativeJob(db, provider(), actor, job.id);
  assert.equal(result.status, "uncertain");
  assert.deepEqual(await getBalance(db, { ownerId: actor }), { ownerId: actor, balance: 30, reserved: 1, available: 29 });
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_assets")).rows[0].count, 0);
});

test("interrupted workers stay uncertain with a durable hold", async (t) => {
  const { db, queue } = await setup(t);
  const job = await queue(provider());
  // Simulate a process exiting after its durable claim and before its response.
  await db.query("UPDATE creative_jobs SET status='running',started_at=now() WHERE id=$1", [job.id]);
  await flagInterruptedCreativeJob(db, actor, job.id);
  const result = await executeCreativeJob(db, provider(async () => assert.fail("crashed request retried")), actor, job.id);
  assert.equal(result.status, "uncertain");
  assert.equal((await getBalance(db, { ownerId: actor })).reserved, 1);
});
