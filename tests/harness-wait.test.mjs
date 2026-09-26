import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrateHistory } from '../src/lib/history/migrate.ts';
import { grantCredits, getBalance } from '../src/lib/credits/ledger.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { createCreativeWorkflow, saveCreativeConcepts, queueCreativeJob, executeCreativeJob, cancelCreativeJob } from '../src/lib/creative/workflow.ts';
import { reconcileCreativeJob } from '../src/lib/creative/reconciliation.ts';
import { ImageProviderError } from '../src/lib/creative/image-provider.ts';
import { projectTools } from '../src/lib/harness/tools.ts';
import { createAgentRun, readAgentRun, runAgentToCheckpoint, advanceAgentRun, cancelAgentRun, deleteAgentRun } from '../src/lib/harness/runner.ts';

const ownerId = 'fixture-owner';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
const provider = generate => ({ id: 'fixture', model: 'fixture', mode: 'test', available: true, generate: generate ?? (async () => ({ bytes: png, mimeType: 'image/png' })) });
async function setup(t, { p = provider(), maxSteps = 8 } = {}) {
  const pg = new PGlite();
  const sql = client => ({ query: (q, v) => client.query(q, v), exec: q => client.exec(q) });
  const db = { ...sql(pg), transaction: fn => pg.transaction(tx => fn(sql(tx))), close: () => pg.close() };
  t.after(() => db.close());
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId, name: 'Fixture', context: { game: 'Fixture', gameplay: 'Plant', audience: 'Mixed', artDirection: 'Paper' } });
  await grantCredits(db, { ownerId, operationId: randomUUID(), amount: 10 });
  const flow = await createCreativeWorkflow(db, { ownerId, projectId: project.id, kind: 'thumbnail', brief: { goal: 'Plant', truthfulContent: 'Plant', visualDirection: 'Paper' }, creditBudget: 3 });
  await saveCreativeConcepts(db, ownerId, flow.id, [{ key: 'seed', title: 'Seed', hypothesis: 'Clear', prompt: 'Seed', assets: [] }]);
  const run = await createAgentRun(db, { ownerId, projectId: project.id, objective: 'Render concept', allowedTools: ['queue_image'], autoProjectWrites: true, maxSteps });
  const tools = projectTools(db, undefined, { provider: p });
  let modelCalls = 0;
  const seen = [];
  const model = { id: 'fixture', mode: 'test', next: async input => {
    modelCalls++; seen.push(input);
    if (!input.observations.length) return { kind: 'tool', tool: 'queue_image', input: { workflowId: flow.id, conceptKey: 'seed', stage: 'concept' }, reason: 'Render' };
    if (input.observations.length === 1) return { kind: 'wait', jobId: input.observations[0].result.id, reason: 'Need the render' };
    return { kind: 'final', text: `Image job: ${input.observations.at(-1).result.status}.` };
  } };
  const checkpoint = () => runAgentToCheckpoint(db, model, tools, ownerId, run.id);
  return { db, project, flow, run, tools, model, p, seen, checkpoint, calls: () => modelCalls };
}

test('waiting survives checkpoints without model polling and resumes from the actual image', async t => {
  const s = await setup(t);
  let state = await s.checkpoint();
  assert.equal(state.status, 'waiting'); assert.equal(s.calls(), 2);
  assert.equal(state.steps, 2); assert.equal(state.claim_id, null);
  const jobId = state.waiting_job_id;
  assert.equal(state.actions[0].id, jobId);
  for (let i = 0; i < 4; i++) {
    const pending = await s.checkpoint();
    assert.equal(pending.status, 'waiting'); assert.equal(pending.steps, 2);
  }
  assert.equal(s.calls(), 2);
  assert.equal((await getBalance(s.db, { ownerId })).reserved, 1);
  await executeCreativeJob(s.db, s.p, ownerId, jobId);
  // Rebuild the registry as a restarted coordinator would; no promise or local
  // controller is needed to know which image this run was awaiting.
  state = await runAgentToCheckpoint(s.db, s.model, projectTools(s.db, undefined, { provider: s.p }), ownerId, s.run.id);
  assert.equal(state.status, 'completed'); assert.equal(s.calls(), 3);
  assert.equal(state.waiting_job_id, null); assert.equal(state.steps, 3);
  const observed = s.seen.at(-1).observations.at(-1);
  assert.equal(observed.tool, 'await_image_job'); assert.equal(observed.result.status, 'succeeded');
  assert.ok(observed.result.assetId); assert.equal(observed.result.id, jobId);
  assert.ok(!JSON.stringify(observed).includes('prompt'));
});

test('known failures and cancellations resume as failed/cancelled observations', async t => {
  for (const outcome of ['failed', 'cancelled']) {
    const s = await setup(t, { p: provider(async () => { throw new ImageProviderError('rejected'); }) });
    const pending = await s.checkpoint();
    if (outcome === 'failed') await executeCreativeJob(s.db, s.p, ownerId, pending.waiting_job_id);
    else await cancelCreativeJob(s.db, ownerId, pending.waiting_job_id);
    const completed = await s.checkpoint();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.final_text, `Image job: ${outcome}.`);
    assert.equal((await getBalance(s.db, { ownerId })).reserved, 0);
  }
});

test('uncertain jobs hold the agent without model calls until operator reconciliation', async t => {
  const s = await setup(t, { p: provider(async () => { throw new Error('network uncertain'); }) });
  const pending = await s.checkpoint();
  await executeCreativeJob(s.db, s.p, ownerId, pending.waiting_job_id);
  let state = await s.checkpoint();
  assert.equal(state.status, 'waiting'); assert.equal(state.error_code, 'image_reconciliation_required');
  assert.equal(s.calls(), 2);
  await reconcileCreativeJob(s.db, { ownerId, projectId: s.project.id, jobId: pending.waiting_job_id, resolutionId: randomUUID(), operatorId: 'fixture-operator', workerStopped: true, evidenceId: 'test-receipt', outcome: 'not_charged', actualCredits: 0 });
  state = await s.checkpoint();
  assert.equal(state.status, 'completed'); assert.equal(state.error_code, null);
  assert.equal(state.final_text, 'Image job: failed.'); assert.equal(s.calls(), 3);
});

test('only the same run can await a job, even when the owner and project match', async t => {
  const s = await setup(t);
  const foreign = await queueCreativeJob(s.db, s.p, { ownerId, workflowId: s.flow.id, jobId: randomUUID(), conceptKey: 'seed', stage: 'concept' });
  const model = { id: 'fixture', mode: 'test', next: async () => ({ kind: 'wait', jobId: foreign.id, reason: 'Guessed job' }) };
  const state = await runAgentToCheckpoint(s.db, model, s.tools, ownerId, s.run.id);
  assert.equal(state.status, 'failed'); assert.equal(state.actions.length, 0);
  await assert.rejects(advanceAgentRun(s.db, s.model, s.tools, 'stranger', s.run.id), error => error.code === 'not_found');
});

test('cancelling a waiting agent prevents late completion from reviving it', async t => {
  const s = await setup(t);
  const pending = await s.checkpoint();
  await cancelAgentRun(s.db, ownerId, s.run.id);
  // Cancelling agent reasoning does not pretend to cancel a separately queued
  // provider operation. Its real completion/cost remains recorded on the job.
  await executeCreativeJob(s.db, s.p, ownerId, pending.waiting_job_id);
  const state = await s.checkpoint();
  assert.equal(state.status, 'cancelled'); assert.equal(state.waiting_job_id, null);
  assert.equal(s.calls(), 2); assert.equal(state.actions.at(-1).status, 'failed');
  await deleteAgentRun(s.db, ownerId, s.run.id);
});

test('concurrent resume claims one model step and waiting still respects the step cap', async t => {
  const s = await setup(t);
  const pending = await s.checkpoint();
  await executeCreativeJob(s.db, s.p, ownerId, pending.waiting_job_id);
  await Promise.all(Array.from({ length: 6 }, s.checkpoint));
  assert.equal((await readAgentRun(s.db, ownerId, s.run.id)).status, 'completed');
  assert.equal(s.calls(), 3);
  const capped = await setup(t, { maxSteps: 2 });
  const last = await capped.checkpoint();
  await executeCreativeJob(capped.db, capped.p, ownerId, last.waiting_job_id);
  const state = await capped.checkpoint();
  assert.equal(state.status, 'failed'); assert.equal(state.error_code, 'step_limit');
  assert.equal(capped.calls(), 2);
});
