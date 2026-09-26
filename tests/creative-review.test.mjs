import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { grantCredits } from "../src/lib/credits/ledger.ts";
import { createCreativeProject } from "../src/lib/creative/storage.ts";
import { createCreativeWorkflow, saveCreativeConcepts, queueCreativeJob, executeCreativeJob, readCreativeWorkflow, readCreativeJob } from "../src/lib/creative/workflow.ts";
import { reviewCreativeConcept } from "../src/lib/creative/review.ts";

// All fixtures, hashes and outcomes live in isolated in-memory databases. No real
// provider, model or network call is made; every reviewer here is a local stub.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const pngSha = createHash("sha256").update(png).digest("hex");
const context = { game: "Test garden", gameplay: "Grow and trade plants", audience: "Mixed reading abilities", artDirection: "Paper shapes", constraints: ["Readable on mobile"] };
const brief = { goal: "Show planting", truthfulContent: "Growing plants is available", visualDirection: "One clear action", avoid: ["Fake rewards"] };
const concept = { key: "planting", title: "First seed", hypothesis: "An action may read clearly", prompt: "A hand planting a seed", assets: [] };
const uiConcept = { ...concept, assets: [{ key: "panel", label: "Seed panel", prompt: "A seed tray panel", size: "1024x1024" }, { key: "seed", label: "Seed icon", prompt: "One seed icon", size: "1024x1024" }] };
const actor = "test-owner";
const testProvider = () => ({ id: "test-only", model: "fixture", mode: "test", available: true, generate: async () => ({ bytes: png, mimeType: "image/png" }) });

async function setup(t, options = {}) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId: actor, name: "Test", context });
  await grantCredits(db, { ownerId: actor, operationId: randomUUID(), amount: 30 });
  const flow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: options.kind ?? "thumbnail", brief, creditBudget: 20, allowAgentReview: options.allowAgentReview ?? true });
  await saveCreativeConcepts(db, actor, flow.id, [options.kind === "ui" ? uiConcept : concept]);
  const provider = testProvider();
  const jobId = randomUUID();
  const queued = await queueCreativeJob(db, provider, { ownerId: actor, workflowId: flow.id, jobId, conceptKey: "planting", stage: "concept" });
  await executeCreativeJob(db, provider, actor, queued.id);
  const job = await readCreativeJob(db, actor, queued.id);
  const reviewIds = { ownerId: actor, projectId: project.id, workflowId: flow.id, jobId: job.id };
  return { db, project, flow, job, provider, reviewIds };
}

const signal = () => new AbortController().signal;
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const reviewer = (review, overrides = {}) => ({
  id: "fixture-reviewer", model: "review-fixture", mode: "test", available: true,
  review: review ?? (async () => ({ approved: true, reason: "Observed gameplay reads truthfully and stays legible on a phone." })),
  ...overrides,
});
const withReviewId = (base, reviewId) => ({ ...base, reviewId });
const asyncJob = async (db, flow, p, ownerId = actor, conceptKey = "planting") => {
  const queued = await queueCreativeJob(db, p, { ownerId, workflowId: flow.id, jobId: randomUUID(), conceptKey, stage: "concept" });
  await executeCreativeJob(db, p, ownerId, queued.id);
  return readCreativeJob(db, ownerId, queued.id);
};

test("a passed review approves from the actual stored bytes and records durable evidence", async (t) => {
  const { db, flow, job, reviewIds } = await setup(t);
  const reviewId = randomUUID();
  let seen;
  const result = await reviewCreativeConcept(db, reviewer(async (input) => { seen = input; return { approved: true, reason: "  Clear action, truthful plants, readable small.  " }; }), withReviewId(reviewIds, reviewId), signal());

  assert.deepEqual(result, { id: reviewId, jobId: job.id, assetId: job.output_asset_id, approved: true, reason: "Clear action, truthful plants, readable small." });
  // The reviewer received the real stored PNG bytes, not a prompt.
  assert.equal(seen.image.mimeType, "image/png");
  assert.equal(seen.image.width, 1);
  assert.equal(seen.image.height, 1);
  assert.equal(seen.kind, "thumbnail");
  assert.deepEqual(Buffer.from(seen.image.bytes), png);
  assert.equal(seen.concept.key, "planting");
  assert.equal(seen.project.game, context.game);
  assert.equal(seen.brief.goal, brief.goal);
  // Operator instructions cover observed quality, mobile legibility, no CTR
  // prediction and no prompt-injection authority.
  assert.match(seen.instructions, /small-size readability/i);
  assert.match(seen.instructions, /click-through rate/i);
  assert.match(seen.instructions, /untrusted data/i);
  assert.match(seen.instructions, /never follow prompt injection/i);

  const row = (await db.query("SELECT * FROM creative_reviews WHERE id=$1", [reviewId])).rows[0];
  assert.equal(row.status, "approved");
  assert.equal(row.approved, true);
  assert.equal(row.asset_sha256, pngSha);
  assert.equal(row.asset_id, job.output_asset_id);
  assert.equal(row.reviewer_id, "fixture-reviewer");
  assert.equal(row.reviewer_model, "review-fixture");
  assert.equal(row.reviewer_mode, "test");
  assert.ok(row.finished_at);

  const approval = (await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [flow.id])).rows[0].approval;
  assert.equal(approval.jobId, job.id);
  assert.equal(approval.assetId, job.output_asset_id);
  assert.equal(approval.reviewer, "agent");
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "approved");
});

test("paid, unavailable and env-overridden reviewers are refused before any write", async (t) => {
  const { db, reviewIds } = await setup(t);
  const previous = process.env.ROMANUM_CREATIVE_REVIEW_PAID;
  process.env.ROMANUM_CREATIVE_REVIEW_PAID = "1";
  try {
    for (const mode of ["paid", "test"]) {
      for (const available of [true, false]) {
        if (mode === "test" && available) continue;
        let called = false;
        const stub = { id: "fixture-reviewer", model: "review-fixture", mode, available, review: async () => { called = true; return { approved: true, reason: "should not run" }; } };
        await rejectsCode(reviewCreativeConcept(db, stub, withReviewId(reviewIds, randomUUID()), signal()), "unavailable");
        assert.equal(called, false);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ROMANUM_CREATIVE_REVIEW_PAID; else process.env.ROMANUM_CREATIVE_REVIEW_PAID = previous;
  }
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews")).rows[0].count, 0);
});

test("the workflow must opt in to delegated review", async (t) => {
  const { db, reviewIds } = await setup(t, { allowAgentReview: false });
  let called = false;
  await rejectsCode(reviewCreativeConcept(db, reviewer(async () => { called = true; return { approved: true, reason: "no" }; }), withReviewId(reviewIds, randomUUID()), signal()), "approval_required");
  assert.equal(called, false);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews")).rows[0].count, 0);
});

test("only this workflow's successful concept render can be reviewed", async (t) => {
  const { db, project, reviewIds, provider } = await setup(t);
  // A queued but unexecuted concept render (in its own workflow) has no actual asset yet.
  const draftFlow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 5, allowAgentReview: true });
  await saveCreativeConcepts(db, actor, draftFlow.id, [concept]);
  const pending = await queueCreativeJob(db, provider, { ownerId: actor, workflowId: draftFlow.id, jobId: randomUUID(), conceptKey: "planting", stage: "concept" });
  await rejectsCode(reviewCreativeConcept(db, reviewer(), { ownerId: actor, projectId: project.id, workflowId: draftFlow.id, jobId: pending.id, reviewId: randomUUID() }, signal()), "approval_required");

  // A job from a different workflow is out of scope for this review.
  const otherFlow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 5, allowAgentReview: true });
  await saveCreativeConcepts(db, actor, otherFlow.id, [concept]);
  const foreign = await asyncJob(db, otherFlow, testProvider());
  await rejectsCode(reviewCreativeConcept(db, reviewer(), { ...reviewIds, jobId: foreign.id, reviewId: randomUUID() }, signal()), "not_found");

  // An unknown job id is not in scope.
  await rejectsCode(reviewCreativeConcept(db, reviewer(), { ...reviewIds, jobId: randomUUID(), reviewId: randomUUID() }, signal()), "not_found");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews")).rows[0].count, 0);
});

test("a false review is recorded and never approves the concept", async (t) => {
  const { db, flow, job, reviewIds } = await setup(t);
  const reviewId = randomUUID();
  const result = await reviewCreativeConcept(db, reviewer(async () => ({ approved: false, reason: "Static composition hides the core planting action." })), withReviewId(reviewIds, reviewId), signal());
  assert.equal(result.approved, false);
  assert.equal(result.reason, "Static composition hides the core planting action.");
  assert.equal(result.assetId, job.output_asset_id);
  const row = (await db.query("SELECT * FROM creative_reviews WHERE id=$1", [reviewId])).rows[0];
  assert.equal(row.status, "rejected");
  assert.equal(row.approved, false);
  assert.equal(row.error_code, null);
  assert.equal((await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [flow.id])).rows[0].approval, null);
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "review");
});

test("failures, refusals and invalid outcomes are stored safely without leaking provider bodies", async (t) => {
  const { db, flow, reviewIds } = await setup(t);
  const cases = [
    [async () => { throw new Error("secret sk-live provider body must not persist"); }, "failed", "review_failed"],
    [async () => ({ approved: false, reason: "Refused: cannot confirm the action is real." }), "rejected", null],
    [async () => ({ approved: "yes", reason: "coerced" }), "failed", "invalid_outcome"],
    [async () => ({ approved: true }), "failed", "invalid_outcome"],
    [async () => ({ approved: true, reason: "ok", extra: 1 }), "failed", "invalid_outcome"],
    [async () => ({ approved: true, reason: "x".repeat(501) }), "failed", "invalid_outcome"],
    [async () => "not json at all", "failed", "invalid_outcome"],
  ];
  for (const [review, expectedStatus, expectedCode] of cases) {
    const reviewId = randomUUID();
    const result = await reviewCreativeConcept(db, reviewer(review), withReviewId(reviewIds, reviewId), signal());
    assert.equal(result.approved, false);
    assert.ok(result.reason.length >= 1 && result.reason.length <= 500);
    const row = (await db.query("SELECT * FROM creative_reviews WHERE id=$1", [reviewId])).rows[0];
    assert.equal(row.status, expectedStatus);
    assert.equal(row.error_code, expectedCode);
    assert.ok(row.reason.length >= 1 && !row.reason.includes("secret"));
  }
  assert.equal((await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [flow.id])).rows[0].approval, null);
});

test("aborted signals and stale late approvals never approve a concept", async (t) => {
  const { db, flow, reviewIds } = await setup(t);

  // Aborted before the call: the reviewer is never invoked.
  let earlyCalled = false;
  const pre = new AbortController();
  pre.abort();
  const earlyId = randomUUID();
  const early = await reviewCreativeConcept(db, reviewer(async () => { earlyCalled = true; return { approved: true, reason: "late yes" }; }), withReviewId(reviewIds, earlyId), pre.signal);
  assert.equal(earlyCalled, false);
  assert.equal(early.approved, false);
  assert.equal((await db.query("SELECT * FROM creative_reviews WHERE id=$1", [earlyId])).rows[0].status, "failed");

  // Aborted mid-call: a late "approved: true" must not approve.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const lateId = randomUUID();
  const pending = reviewCreativeConcept(db, reviewer(async () => { await gate; return { approved: true, reason: "late yes" }; }), withReviewId(reviewIds, lateId), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  release();
  const late = await pending;
  assert.equal(late.approved, false);
  const lateRow = (await db.query("SELECT * FROM creative_reviews WHERE id=$1", [lateId])).rows[0];
  assert.equal(lateRow.status, "failed");
  assert.equal(lateRow.approved, false);
  assert.equal((await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [flow.id])).rows[0].approval, null);
});

test("concurrent duplicate claims call the model once, while a stale claim is never retried", async (t) => {
  const { db, reviewIds } = await setup(t);
  const reviewId = randomUUID();
  let calls = 0;
  const shared = reviewer(async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { approved: true, reason: "one observed pass" }; });
  const ids = withReviewId(reviewIds, reviewId);
  const [a, b] = await Promise.all([reviewCreativeConcept(db, shared, ids, signal()), reviewCreativeConcept(db, shared, ids, signal())]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews WHERE id=$1", [reviewId])).rows[0].count, 1);

  // A crashed worker leaves a durable 'claimed' row that must not be taken over.
  const crashedId = randomUUID();
  await db.query("INSERT INTO creative_reviews(id,owner_id,project_id,workflow_id,job_id,asset_id,reviewer_id,reviewer_model,reviewer_mode,asset_sha256,status,claim_id,claimed_at) VALUES($1,$2,$3,$4,$5,$6,'fixture-reviewer','review-fixture','test',$7,'claimed',$8,now())", [crashedId, ids.ownerId, ids.projectId, ids.workflowId, ids.jobId, (await db.query("SELECT output_asset_id FROM creative_jobs WHERE id=$1", [ids.jobId])).rows[0].output_asset_id, pngSha, randomUUID()]);
  let crashedCalled = false;
  await rejectsCode(reviewCreativeConcept(db, reviewer(async () => { crashedCalled = true; return { approved: true, reason: "should not run" }; }), withReviewId(reviewIds, crashedId), signal()), "conflict");
  assert.equal(crashedCalled, false);
});

test("a finished review replays without a second call and conflicting key reuse is rejected", async (t) => {
  const { db, project } = await setup(t);
  const alternate = { ...concept, key: "watering", title: "Watering", prompt: "A hand watering a plant" };
  const flow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 10, allowAgentReview: true });
  await saveCreativeConcepts(db, actor, flow.id, [concept, alternate]);
  const provider = testProvider();
  const firstJob = await asyncJob(db, flow, provider);
  const reviewId = randomUUID();
  let calls = 0;
  const stub = reviewer(async () => { calls += 1; return { approved: true, reason: "stable outcome" }; });
  const ids = { ownerId: actor, projectId: project.id, workflowId: flow.id, jobId: firstJob.id, reviewId };
  const first = await reviewCreativeConcept(db, stub, ids, signal());
  const replay = await reviewCreativeConcept(db, stub, ids, signal());
  assert.equal(calls, 1);
  assert.deepEqual(replay, first);

  // Same id with a different job of the same workflow is a key conflict.
  const secondJob = await asyncJob(db, flow, provider, actor, "watering");
  await rejectsCode(reviewCreativeConcept(db, stub, { ...ids, jobId: secondJob.id }, signal()), "conflict");
  // Same id with a different reviewer identity is a key conflict too.
  await rejectsCode(reviewCreativeConcept(db, reviewer(async () => { calls += 1; return { approved: true, reason: "x" }; }, { model: "different-model" }), ids, signal()), "conflict");
  assert.equal(calls, 1);

  // Same id reused by another owner is a conflict, not a fresh claim.
  const otherOwner = "other-owner";
  const otherProject = await createCreativeProject(db, { ownerId: otherOwner, name: "Other", context });
  await grantCredits(db, { ownerId: otherOwner, operationId: randomUUID(), amount: 5 });
  const otherFlow2 = await createCreativeWorkflow(db, { ownerId: otherOwner, projectId: otherProject.id, kind: "thumbnail", brief, creditBudget: 5, allowAgentReview: true });
  await saveCreativeConcepts(db, otherOwner, otherFlow2.id, [concept]);
  const otherJob2 = await asyncJob(db, otherFlow2, testProvider(), otherOwner);
  await rejectsCode(reviewCreativeConcept(db, stub, { ownerId: otherOwner, projectId: otherProject.id, workflowId: otherFlow2.id, jobId: otherJob2.id, reviewId }, signal()), "conflict");
  assert.equal(calls, 1);
});

test("review attempts per workflow are capped", async (t) => {
  const { db, reviewIds } = await setup(t);
  const job = (await db.query("SELECT output_asset_id FROM creative_jobs WHERE id=$1", [reviewIds.jobId])).rows[0];
  for (let index = 0; index < 24; index += 1) {
    await db.query("INSERT INTO creative_reviews(id,owner_id,project_id,workflow_id,job_id,asset_id,reviewer_id,reviewer_model,reviewer_mode,asset_sha256,status,claim_id,claimed_at,finished_at,approved,error_code) VALUES($1,$2,$3,$4,$5,$6,'prior','prior-model','test',$7,'failed',$8,now(),now(),false,'review_failed')", [randomUUID(), reviewIds.ownerId, reviewIds.projectId, reviewIds.workflowId, reviewIds.jobId, job.output_asset_id, pngSha, randomUUID()]);
  }
  let called = false;
  await rejectsCode(reviewCreativeConcept(db, reviewer(async () => { called = true; return { approved: true, reason: "over cap" }; }), withReviewId(reviewIds, randomUUID()), signal()), "conflict");
  assert.equal(called, false);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews")).rows[0].count, 24);
});

test("reviews stay inside their owner and project boundaries", async (t) => {
  const { db, project, reviewIds } = await setup(t);
  const otherProject = await createCreativeProject(db, { ownerId: actor, name: "Other", context });
  await rejectsCode(reviewCreativeConcept(db, reviewer(), { ...reviewIds, ownerId: "other-owner", reviewId: randomUUID() }, signal()), "not_found");
  await rejectsCode(reviewCreativeConcept(db, reviewer(), { ...reviewIds, projectId: otherProject.id, reviewId: randomUUID() }, signal()), "not_found");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_reviews")).rows[0].count, 0);
  assert.equal((await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [reviewIds.workflowId])).rows[0].approval, null);

  // Confirm the asset only exists in its own project scope.
  const asset = (await db.query("SELECT id FROM creative_assets WHERE project_id=$1", [project.id])).rows[0];
  assert.ok(asset);
});

test("a passed review unblocks the approved asset queue with the reviewed asset", async (t) => {
  const { db, flow, reviewIds, provider } = await setup(t, { kind: "ui" });
  await rejectsCode(queueCreativeJob(db, provider, { ownerId: actor, workflowId: flow.id, jobId: randomUUID(), conceptKey: "planting", stage: "asset", assetKey: "panel" }), "approval_required");
  await reviewCreativeConcept(db, reviewer(async () => ({ approved: true, reason: "Approved for asset production." })), withReviewId(reviewIds, randomUUID()), signal());
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "approved");

  const calls = [];
  const assetProvider = { ...testProvider(), generate: async (request) => { calls.push(request); return { bytes: png, mimeType: "image/png" }; } };
  for (const assetKey of ["panel", "seed"]) {
    const assetJob = await queueCreativeJob(db, assetProvider, { ownerId: actor, workflowId: flow.id, jobId: randomUUID(), conceptKey: "planting", stage: "asset", assetKey });
    assert.equal((await executeCreativeJob(db, assetProvider, actor, assetJob.id)).status, "succeeded");
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.transparent && call.references.length === 1));
  assert.deepEqual(Buffer.from(calls[0].references[0].bytes), png);
  assert.equal((await readCreativeWorkflow(db, actor, flow.id)).phase, "assets_ready");
});

test("approving a second concept of the same workflow conflicts after the first pass", async (t) => {
  // One workflow can hold several concepts; a second render cannot be approved
  // once the workflow already records a pass for a different concept.
  const { db, project } = await setup(t);
  const alternate = { ...concept, key: "watering", title: "Watering", prompt: "A hand watering a plant" };
  const flow = await createCreativeWorkflow(db, { ownerId: actor, projectId: project.id, kind: "thumbnail", brief, creditBudget: 5, allowAgentReview: true });
  await saveCreativeConcepts(db, actor, flow.id, [concept, alternate]);
  const provider = testProvider();
  const first = await queueCreativeJob(db, provider, { ownerId: actor, workflowId: flow.id, jobId: randomUUID(), conceptKey: "planting", stage: "concept" });
  await executeCreativeJob(db, provider, actor, first.id);
  const firstPass = await reviewCreativeConcept(db, reviewer(async () => ({ approved: true, reason: "First concept approved." })), { ownerId: actor, projectId: project.id, workflowId: flow.id, jobId: first.id, reviewId: randomUUID() }, signal());
  assert.equal(firstPass.approved, true);

  const second = await queueCreativeJob(db, provider, { ownerId: actor, workflowId: flow.id, jobId: randomUUID(), conceptKey: "watering", stage: "concept" });
  await executeCreativeJob(db, provider, actor, second.id);
  const conflictId = randomUUID();
  await rejectsCode(reviewCreativeConcept(db, reviewer(async () => ({ approved: true, reason: "Second concept approved." })), { ownerId: actor, projectId: project.id, workflowId: flow.id, jobId: second.id, reviewId: conflictId }, signal()), "conflict");
  const approval = (await db.query("SELECT approval FROM creative_workflows WHERE id=$1", [flow.id])).rows[0].approval;
  assert.equal(approval.jobId, first.id);
  assert.equal((await db.query("SELECT status FROM creative_reviews WHERE id=$1", [conflictId])).rows[0].status, "failed");
});
