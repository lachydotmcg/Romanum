import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrateHistory } from '../src/lib/history/migrate.ts';
import { grantCredits, getBalance } from '../src/lib/credits/ledger.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { reviewCreativeConcept } from '../src/lib/creative/review.ts';
import { createCreativeWorkflow, saveCreativeConcepts, readCreativeWorkflow, executeCreativeJob } from '../src/lib/creative/workflow.ts';
import { projectTools } from '../src/lib/harness/tools.ts';
import { createAgentRun, advanceAgentRun, runAgentToCheckpoint, reviewAgentAction } from '../src/lib/harness/runner.ts';

// Isolated fixtures never enter the website, shared library or a paid provider.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
const owner = 'test-creator';
const context = { game: 'Test game', gameplay: 'Plant a seed', audience: 'Mixed readers', artDirection: 'Paper' };
const brief = { goal: 'Seed menu', truthfulContent: 'Plant seeds', visualDirection: 'Simple paper panels' };
const concept = { key: 'seed', title: 'Seed tray', hypothesis: 'Clear slots', prompt: 'Paper tray', assets: [{ key: 'tray', label: 'Tray', prompt: 'Isolated tray', size: '1024x1024' }] };
const provider = (generate = async () => ({ bytes: png, mimeType: 'image/png' })) => ({ id: 'test', model: 'fixture', mode: 'test', available: true, generate });
const reviewer = (review = async () => ({ approved: true, reason: 'Fixture pixels inspected' })) => ({ id: 'vision-test', model: 'fixture', mode: 'test', available: true, review });
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);
async function setup(t) {
  const pg = new PGlite();
  const sql = client => ({ query: (q, values) => client.query(q, values), exec: q => client.exec(q) });
  const db = { ...sql(pg), transaction: fn => pg.transaction(tx => fn(sql(tx))), close: () => pg.close() };
  t.after(() => db.close());
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId: owner, name: 'Private', context });
  await grantCredits(db, { ownerId: owner, operationId: randomUUID(), amount: 10 });
  const c = { ownerId: owner, projectId: project.id, runId: randomUUID(), actionId: randomUUID(), signal: new AbortController().signal };
  return { db, project, c };
}
const find = (tools, name) => { const tool = tools.find(t => t.name === name); assert.ok(tool, name); return tool; };
async function prepare(tools, c) {
  const flow = await find(tools, 'create_creative_brief').execute({ kind: 'ui', brief, creditBudget: 3 }, c);
  await find(tools, 'propose_concepts').execute({ workflowId: flow.id, concepts: [concept] }, c);
  return flow;
}

test('an agent queues a concept, delegates actual image review, then queues its separate UI asset', async t => {
  const { db, project } = await setup(t);
  const requests = [], reviews = [];
  const p = provider(async request => { requests.push(request); return { bytes: png, mimeType: 'image/png' }; });
  const vision = reviewer(async input => { reviews.push(input); assert.equal(input.kind, 'ui'); assert.ok(input.instructions.includes('editable Roblox text')); assert.deepEqual(Buffer.from(input.image.bytes), png); return { approved: true, reason: 'Fixture visual review complete' }; });
  const tools = projectTools(db, undefined, { provider: p, reviewer: vision, allowAgentReview: true, maxWorkflowCredits: 3 });
  const run = await createAgentRun(db, { ownerId: owner, projectId: project.id, objective: 'Create a seed tray UI', allowedTools: ['create_creative_brief', 'propose_concepts', 'queue_image', 'review_concept', 'read_creative_workflow'], autoProjectWrites: true });
  const call = (tool, input) => ({ kind: 'tool', tool, input, reason: 'Continue the requested UI' });
  const model = { id: 'test', mode: 'test', next: async ({ observations }) => {
    const flowId = observations[0]?.result?.id;
    switch (observations.length) {
      case 0: return call('create_creative_brief', { kind: 'ui', brief, creditBudget: 3 });
      case 1: return call('propose_concepts', { workflowId: flowId, concepts: [concept] });
      case 2: return call('queue_image', { workflowId: flowId, conceptKey: 'seed', stage: 'concept' });
      case 3: return call('review_concept', { workflowId: flowId, jobId: observations[2].result.id });
      case 4: return call('queue_image', { workflowId: flowId, conceptKey: 'seed', stage: 'asset', assetKey: 'tray' });
      case 5: return call('read_creative_workflow', { workflowId: flowId });
      default:
        assert.equal(observations.at(-1).result.phase, 'assets_ready');
        return { kind: 'final', text: 'The test asset is ready; it has not been applied in Studio.' };
    }
  } };
  let state = run;
  const dispatched = new Set();
  for (let i = 0; i < 24 && state.status === 'ready'; i++) {
    state = await advanceAgentRun(db, model, tools, owner, run.id);
    // A separate worker processes durable jobs between agent steps. The tools
    // themselves never render synchronously or imply that queueing is success.
    for (const action of state.actions.filter(a => a.tool_name === 'queue_image' && a.status === 'succeeded')) {
      if (dispatched.has(action.id)) continue;
      dispatched.add(action.id);
      assert.equal(action.result.status, 'queued');
      assert.equal(action.result.id, action.id);
      await executeCreativeJob(db, p, owner, action.result.id);
    }
  }
  assert.equal(state.status, 'completed');
  assert.equal(requests.length, 2); assert.equal(reviews.length, 1);
  assert.equal(requests[1].transparent, true);
  assert.deepEqual(Buffer.from(requests[1].references[0].bytes), png);
  assert.equal((await getBalance(db, { ownerId: owner })).balance, 8);
  assert.ok(!JSON.stringify(state.actions).includes(png.toString('base64')));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM ui_library_entries')).rows[0].n, 0);
});

test('generation/review tools require trusted test providers and separate review delegation', async t => {
  const { db } = await setup(t);
  for (const opts of [{}, { provider: { ...provider(), mode: 'paid' }, reviewer: { ...reviewer(), mode: 'paid' }, allowAgentReview: true }, { provider: { ...provider(), available: false }, reviewer: { ...reviewer(), available: false }, allowAgentReview: true }]) {
    const tools = projectTools(db, undefined, opts);
    assert.ok(!tools.some(t => t.name === 'queue_image' || t.name === 'review_concept'));
  }
  const withoutDelegation = projectTools(db, undefined, { provider: provider(), reviewer: reviewer() });
  assert.ok(withoutDelegation.some(t => t.name === 'queue_image'));
  assert.ok(!withoutDelegation.some(t => t.name === 'review_concept'));
  assert.throws(() => find(withoutDelegation, 'create_creative_brief').parse({ kind: 'ui', brief, creditBudget: 3, allowAgentReview: true }));
});

test('queueing is idempotent per action and cancellation releases its hold without rendering', async t => {
  const { db, c } = await setup(t);
  const tools = projectTools(db, undefined, { provider: provider(() => assert.fail('queue must not render')) });
  const flow = await prepare(tools, c);
  const input = { workflowId: flow.id, conceptKey: 'seed', stage: 'concept' };
  const first = await find(tools, 'queue_image').execute(input, c);
  assert.deepEqual(await find(tools, 'queue_image').execute(input, c), first);
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 1);
  const cancelled = await find(tools, 'cancel_image_job').execute({ jobId: first.id }, c);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 0);
});

test('project/owner boundaries apply to workflow reads, image queueing and cancellation', async t => {
  const { db, c } = await setup(t);
  const tools = projectTools(db, undefined, { provider: provider() });
  const flow = await prepare(tools, c);
  const queued = await find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, c);
  const other = await createCreativeProject(db, { ownerId: owner, name: 'Other', context });
  for (const untrusted of [{ ...c, projectId: other.id }, { ...c, ownerId: 'stranger' }]) {
    await rejectCode(find(tools, 'read_creative_workflow').execute({ workflowId: flow.id }, untrusted), 'not_found');
    await rejectCode(find(tools, 'propose_concepts').execute({ workflowId: flow.id, concepts: [concept] }, untrusted), 'not_found');
    await rejectCode(find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, untrusted), 'not_found');
    await rejectCode(find(tools, 'read_image_job').execute({ jobId: queued.id }, untrusted), 'not_found');
    await rejectCode(find(tools, 'cancel_image_job').execute({ jobId: queued.id }, untrusted), 'not_found');
  }
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 1);
});

test('trusted budget and provider changes cannot reuse an already approved agent action', async t => {
  const { db, project, c } = await setup(t);
  const p = provider();
  const tools = projectTools(db, undefined, { provider: p, maxWorkflowCredits: 3 });
  const flow = await prepare(tools, c);
  assert.throws(() => find(tools, 'create_creative_brief').parse({ kind: 'ui', brief, creditBudget: 4 }));
  const run = await createAgentRun(db, { ownerId: owner, projectId: project.id, objective: 'Render', allowedTools: ['queue_image'] });
  const model = { id: 'test', mode: 'test', next: async () => ({ kind: 'tool', tool: 'queue_image', input: { workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, reason: 'Render concept' }) };
  const pending = await runAgentToCheckpoint(db, model, tools, owner, run.id);
  const action = pending.actions[0];
  assert.equal(pending.status, 'awaiting_approval');
  await reviewAgentAction(db, { ownerId: owner, runId: run.id, actionId: action.id, digest: action.digest, approve: true });
  const changed = projectTools(db, undefined, { provider: { ...p, model: 'different' }, maxWorkflowCredits: 3 });
  assert.equal((await advanceAgentRun(db, model, changed, owner, run.id)).status, 'failed');
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 0);
  p.mode = 'paid';
  await rejectCode(find(tools, 'queue_image').execute(action.input, c), 'unavailable');
});

test('unreviewed assets, oversized existing budgets and aborted actions cannot queue', async t => {
  const { db, project, c } = await setup(t);
  const tools = projectTools(db, undefined, { provider: provider(), maxWorkflowCredits: 3 });
  const flow = await prepare(tools, c);
  await rejectCode(find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'asset', assetKey: 'tray' }, c), 'approval_required');
  const bigger = await createCreativeWorkflow(db, { ownerId: owner, projectId: project.id, kind: 'ui', brief, creditBudget: 4 });
  await saveCreativeConcepts(db, owner, bigger.id, [concept]);
  await rejectCode(find(tools, 'queue_image').execute({ workflowId: bigger.id, conceptKey: 'seed', stage: 'concept' }, c), 'budget_exceeded');
  const aborted = { ...c, signal: AbortSignal.abort() };
  await rejectCode(find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, aborted), 'unavailable');
  assert.equal((await readCreativeWorkflow(db, owner, flow.id)).jobs.length, 0);
});

test('an in-flight review cannot be joined from a different project', async t => {
  const { db, project, c } = await setup(t);
  const isolated = await setup(t);
  const p = provider();
  const tools = projectTools(db, undefined, { provider: p, allowAgentReview: true });
  const flow = await prepare(tools, c);
  const image = await find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, c);
  await executeCreativeJob(db, p, owner, image.id);
  const other = await createCreativeProject(db, { ownerId: owner, name: 'Other', context });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const vision = reviewer(async () => { entered(); await gate; return { approved: true, reason: 'Inspected' }; });
  const ids = { ownerId: owner, projectId: project.id, workflowId: flow.id, jobId: image.id, reviewId: randomUUID() };
  const pending = reviewCreativeConcept(db, vision, ids, c.signal);
  await started;
  const intruders = Promise.allSettled([
    reviewCreativeConcept(db, vision, { ...ids, projectId: other.id }, c.signal),
    reviewCreativeConcept(isolated.db, vision, ids, c.signal),
  ]);
  // Release after both calls started; an implementation must still scope the
  // second call instead of returning the first caller's private review promise.
  release();
  for (const result of await intruders) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'not_found'); }
  assert.equal((await pending).approved, true);
});

test('cancellation while waiting to commit visual review cannot approve the workflow', async t => {
  const { db, c } = await setup(t);
  const p = provider();
  const tools = projectTools(db, undefined, { provider: p, allowAgentReview: true });
  const flow = await prepare(tools, c);
  const image = await find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, c);
  await executeCreativeJob(db, p, owner, image.id);
  for (const boundary of [/SELECT allow_agent_review, approval/, /UPDATE creative_workflows SET approval/, /UPDATE creative_reviews SET status='approved'/]) {
    const controller = new AbortController();
    let reviewed = false;
    const delayed = { ...db, transaction: fn => db.transaction(sql => fn({ ...sql, query: async (query, values) => {
      const result = await sql.query(query, values);
      if (reviewed && boundary.test(query)) controller.abort();
      return result;
    } })) };
    const vision = reviewer(async () => { reviewed = true; return { approved: true, reason: 'Late pass' }; });
    const result = await reviewCreativeConcept(delayed, vision, { ownerId: owner, projectId: c.projectId, workflowId: flow.id, jobId: image.id, reviewId: randomUUID() }, controller.signal);
    assert.equal(result.approved, false);
    assert.equal((await readCreativeWorkflow(db, owner, flow.id)).approval, null);
  }
});

test('aborting an unresponsive reviewer returns without waiting for a late model result', async t => {
  const { db, c } = await setup(t);
  const p = provider();
  const tools = projectTools(db, undefined, { provider: p, allowAgentReview: true });
  const flow = await prepare(tools, c);
  const image = await find(tools, 'queue_image').execute({ workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, c);
  await executeCreativeJob(db, p, owner, image.id);
  const controller = new AbortController();
  const vision = reviewer(() => { controller.abort(); return new Promise(() => {}); });
  const result = await reviewCreativeConcept(db, vision, { ownerId: owner, projectId: c.projectId, workflowId: flow.id, jobId: image.id, reviewId: randomUUID() }, controller.signal);
  assert.equal(result.approved, false);
  assert.equal((await readCreativeWorkflow(db, owner, flow.id)).approval, null);
});
