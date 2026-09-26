import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrateHistory } from '../src/lib/history/migrate.ts';
import { grantCredits, getBalance } from '../src/lib/credits/ledger.ts';
import { createCreativeProject, readCreativeAsset } from '../src/lib/creative/storage.ts';
import { createCreativeWorkflow, saveCreativeConcepts, queueCreativeJob, executeCreativeJob, approveCreativeConcept, readCreativeWorkflow, flagInterruptedCreativeJob } from '../src/lib/creative/workflow.ts';
import { reconcileCreativeJob } from '../src/lib/creative/reconciliation.ts';
import { projectTools } from '../src/lib/harness/tools.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
const ownerId = 'test-owner';
const context = { game: 'Fixture', gameplay: 'Plant', audience: 'Mixed', artDirection: 'Paper' };
const brief = { goal: 'Plant', truthfulContent: 'Planting', visualDirection: 'Paper' };
const concepts = [{ key: 'seed', title: 'Seed', hypothesis: 'Clear action', prompt: 'A seed', assets: [] }];
const provider = generate => ({ id: 'fixture', model: 'fixture', mode: 'test', available: true, generate: generate ?? (async () => { throw new Error('uncertain response'); }) });
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);

async function setup(t, budget = 10) {
  const pg = new PGlite();
  const sql = client => ({ query: (q, values) => client.query(q, values), exec: q => client.exec(q) });
  const db = { ...sql(pg), transaction: fn => pg.transaction(tx => fn(sql(tx))), close: () => pg.close() };
  t.after(() => db.close());
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId, name: 'Private fixture', context });
  await grantCredits(db, { ownerId, operationId: randomUUID(), amount: 30 });
  const flow = await createCreativeWorkflow(db, { ownerId, projectId: project.id, kind: 'thumbnail', brief, creditBudget: budget });
  await saveCreativeConcepts(db, ownerId, flow.id, concepts);
  const queue = (p = provider(), stage = 'concept') => queueCreativeJob(db, p, { ownerId, workflowId: flow.id, jobId: randomUUID(), conceptKey: 'seed', stage });
  const job = await queue();
  const base = { ownerId, projectId: project.id, jobId: job.id, resolutionId: randomUUID(), operatorId: 'test-operator', workerStopped: true, evidenceId: 'local-receipt-1' };
  return { db, project, flow, job, queue, base };
}
const notCharged = base => ({ ...base, outcome: 'not_charged', actualCredits: 0 });
const recovered = (base, actualCredits = 1) => ({ ...base, outcome: 'recovered', actualCredits, output: { bytes: png, mimeType: 'image/png' } });

test('a verified no-charge result releases once and permits a new explicit retry', async t => {
  const { db, job, queue, base } = await setup(t, 1);
  await executeCreativeJob(db, provider(), ownerId, job.id);
  const decision = notCharged(base);
  const result = await reconcileCreativeJob(db, decision);
  assert.equal(result.status, 'failed'); assert.equal(result.outputAssetId, null);
  assert.deepEqual(await reconcileCreativeJob(db, decision), result);
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 30, reserved: 0, available: 30 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_ledger WHERE entry_type='release'")).rows[0].n, 1);
  const retry = await queue();
  assert.notEqual(retry.id, job.id); assert.equal(retry.status, 'queued');
  const old = await executeCreativeJob(db, provider(() => assert.fail('resolved job reran')), ownerId, job.id);
  assert.equal(old.status, 'failed');
});

test('charges without an output still consume the workflow budget', async t => {
  const { db, job, queue, base } = await setup(t, 1);
  await executeCreativeJob(db, provider(), ownerId, job.id);
  const result = await reconcileCreativeJob(db, { ...base, outcome: 'charged_without_output', actualCredits: 1 });
  assert.equal(result.status, 'failed'); assert.equal(result.actualCredits, 1);
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 29, reserved: 0, available: 29 });
  await rejectCode(queue(), 'budget_exceeded');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_assets')).rows[0].n, 0);
});

test('recovered concept bytes settle atomically and still need concept review', async t => {
  const { db, project, flow, job, queue, base } = await setup(t);
  await executeCreativeJob(db, provider(), ownerId, job.id);
  const result = await reconcileCreativeJob(db, recovered(base));
  assert.equal(result.status, 'succeeded');
  const asset = await readCreativeAsset(db, ownerId, project.id, result.outputAssetId);
  assert.deepEqual(Buffer.from(asset.bytes), png);
  assert.equal(asset.metadata.mode, 'test'); assert.equal(asset.metadata.reconciliationId, base.resolutionId);
  assert.equal((await readCreativeWorkflow(db, ownerId, flow.id)).phase, 'review');
  await rejectCode(queue(provider(), 'final'), 'approval_required');
  await approveCreativeConcept(db, { ownerId, workflowId: flow.id, jobId: job.id, reviewer: 'owner', reason: 'Recovered image inspected' });
  assert.equal((await queue(provider(), 'final')).status, 'queued');
  await reconcileCreativeJob(db, recovered(base));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_assets')).rows[0].n, 1);
});

test('a lower verified cost releases the unused portion of a final-image hold', async t => {
  const { db, flow, job, queue, base } = await setup(t);
  await executeCreativeJob(db, provider(async () => ({ bytes: png, mimeType: 'image/png' })), ownerId, job.id);
  await approveCreativeConcept(db, { ownerId, workflowId: flow.id, jobId: job.id, reviewer: 'owner', reason: 'Inspected' });
  const final = await queue(provider(), 'final');
  await executeCreativeJob(db, provider(), ownerId, final.id);
  assert.equal((await getBalance(db, { ownerId })).reserved, 2);
  await reconcileCreativeJob(db, recovered({ ...base, jobId: final.id }, 1));
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 28, reserved: 0, available: 28 });
  assert.equal((await readCreativeWorkflow(db, ownerId, flow.id)).phase, 'assets_ready');
});

test('scope, paid modes, running jobs and invalid evidence cannot alter a hold', async t => {
  const { db, project, job, base } = await setup(t);
  await rejectCode(reconcileCreativeJob(db, notCharged(base)), 'conflict');
  await db.query("UPDATE creative_jobs SET status='running' WHERE id=$1", [job.id]);
  await rejectCode(reconcileCreativeJob(db, notCharged(base)), 'conflict');
  await flagInterruptedCreativeJob(db, ownerId, job.id);
  const other = await createCreativeProject(db, { ownerId, name: 'Other', context });
  await rejectCode(reconcileCreativeJob(db, notCharged({ ...base, ownerId: 'stranger' })), 'not_found');
  await rejectCode(reconcileCreativeJob(db, notCharged({ ...base, projectId: other.id })), 'not_found');
  for (const invalid of [
    { ...notCharged(base), workerStopped: false }, { ...notCharged(base), evidenceId: '' },
    { ...notCharged(base), actualCredits: 1 }, { ...recovered(base), output: { bytes: Buffer.from('not PNG'), mimeType: 'image/png' } },
    { ...notCharged(base), output: { bytes: png, mimeType: 'image/png' } },
  ]) await assert.rejects(reconcileCreativeJob(db, invalid));
  await rejectCode(reconcileCreativeJob(db, recovered(base, 2)), 'conflict');
  await db.query("UPDATE creative_jobs SET provider_mode='paid' WHERE id=$1", [job.id]);
  await rejectCode(reconcileCreativeJob(db, notCharged(base)), 'unavailable');
  assert.equal((await getBalance(db, { ownerId })).reserved, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_reconciliations')).rows[0].n, 0);
  assert.ok(!projectTools(db).some(tool => /reconcil|settle|grant_credits/.test(tool.name)));
  assert.equal(project.id, base.projectId);
});

test('reconciliation rolls back output and audit when ledger capture cannot commit', async t => {
  const { db, job, base } = await setup(t);
  await executeCreativeJob(db, provider(), ownerId, job.id);
  await db.exec("CREATE FUNCTION fail_capture_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entry_type='capture' THEN RAISE EXCEPTION 'fixture outage'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_capture_fixture BEFORE INSERT ON credits_ledger FOR EACH ROW EXECUTE FUNCTION fail_capture_fixture();");
  await assert.rejects(reconcileCreativeJob(db, recovered(base)));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_reconciliations')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_assets')).rows[0].n, 0);
  assert.equal((await db.query('SELECT status FROM creative_jobs WHERE id=$1', [job.id])).rows[0].status, 'uncertain');
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 30, reserved: 1, available: 29 });
});

test('concurrent duplicate resolutions settle once and changed decisions cannot rewrite them', async t => {
  const { db, job, base } = await setup(t);
  await executeCreativeJob(db, provider(), ownerId, job.id);
  const [a, b] = await Promise.all([reconcileCreativeJob(db, recovered(base)), reconcileCreativeJob(db, recovered(base))]);
  assert.deepEqual(a, b);
  assert.equal((await getBalance(db, { ownerId })).balance, 29);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_ledger WHERE entry_type='capture'")).rows[0].n, 1);
  for (const changed of [notCharged(base), recovered({ ...base, resolutionId: randomUUID() }), recovered({ ...base, evidenceId: 'different' }), recovered(base, 0)]) {
    await rejectCode(reconcileCreativeJob(db, changed), 'conflict');
  }
  await assert.rejects(db.query("UPDATE creative_reconciliations SET evidence_id='rewrite' WHERE id=$1", [base.resolutionId]), /cannot be updated/);
});

test('an old worker response cannot overwrite a reconciled job or charge again', async t => {
  const { db, job, base } = await setup(t);
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const execution = executeCreativeJob(db, provider(async () => { entered(); return pending; }), ownerId, job.id);
  await started;
  // Simulates a late callback from a worker already declared interrupted.
  await flagInterruptedCreativeJob(db, ownerId, job.id);
  const result = await reconcileCreativeJob(db, recovered(base));
  finish({ bytes: png, mimeType: 'image/png' });
  const late = await execution;
  assert.equal(late.output_asset_id, result.outputAssetId);
  assert.equal(late.status, 'succeeded');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM creative_assets')).rows[0].n, 1);
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 29, reserved: 0, available: 29 });
});
