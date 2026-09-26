import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { migrateHistory } from '../src/lib/history/migrate.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { createAgentRun, advanceAgentRun, runAgentToCheckpoint, readAgentRun, reviewAgentAction, cancelAgentRun, recoverInterruptedRun, deleteAgentRun } from '../src/lib/harness/runner.ts';
import { projectTools } from '../src/lib/harness/tools.ts';
import { createUiEntry } from '../src/lib/ui-library/service.ts';

const owner = 'owner';
const context = { game: 'Private fixture', gameplay: 'Private loop', audience: 'Private audience', artDirection: 'Private style' };
async function setup(t, options = {}) {
  const pg = new PGlite();
  const adapter = (sql) => ({ query: (query, values) => sql.query(query, values), exec: (query) => sql.exec(query) });
  const db = { ...adapter(pg), transaction: (fn) => pg.transaction((sql) => fn(adapter(sql))), close: () => pg.close() };
  t.after(() => db.close());
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId: owner, name: 'Private project', context });
  const run = await createAgentRun(db, { ownerId: owner, projectId: project.id, objective: 'Build a UI', allowedTools: ['fixture'], ...options });
  return { db, project, run };
}
function fixture(effect = 'read', scope = 'project', execute = async () => ({ actual: true })) {
  const schema = z.object({ value: z.string().max(50) }).strict();
  return { name: 'fixture', description: 'Fixture tool', version: '1', effect, scope, ...(scope === 'studio' ? { target: { studioId: 'studio-a' } } : {}), inputSchema: z.toJSONSchema(schema), parse: (value) => schema.parse(value), execute };
}
const call = { kind: 'tool', tool: 'fixture', input: { value: 'data' }, reason: 'Use the tool' };
const final = { kind: 'final', text: 'Result ready.' };
const model = (fn = async () => call) => ({ id: 'fixture', mode: 'test', next: fn });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
async function approve(db, runId) {
  const state = await readAgentRun(db, owner, runId);
  const action = state.actions.at(-1);
  return reviewAgentAction(db, { ownerId: owner, runId, actionId: action.id, digest: action.digest, approve: true });
}

test('project agent retains context and actual tool observations across a bounded model loop', async (t) => {
  const { db, run } = await setup(t);
  let calls = 0;
  const result = await runAgentToCheckpoint(db, model(async (input) => {
    assert.deepEqual(input.project, { ...context, constraints: [] });
    assert.ok(input.instructions.includes('untrusted'));
    if (calls++ === 0) return call;
    assert.deepEqual(input.observations[0].result, { actual: true });
    assert.equal(input.observations[0].status, 'succeeded');
    return final;
  }), [fixture()], owner, run.id);
  assert.equal(result.status, 'completed'); assert.equal(result.steps, 2);
  assert.equal(result.final_text, final.text);
  await rejected(readAgentRun(db, 'stranger', run.id), 'not_found');
  await rejected(deleteAgentRun(db, 'stranger', run.id), 'not_found');
  await deleteAgentRun(db, owner, run.id);
  assert.equal((await db.query('SELECT * FROM agent_actions WHERE run_id=$1', [run.id])).rows.length, 0);
});

test('writes require exact owner approval and waiting cannot execute', async (t) => {
  const { db, run } = await setup(t);
  let executed = 0;
  const tool = fixture('write', 'studio', async () => { executed++; return { done: true }; });
  let state = await runAgentToCheckpoint(db, model(), [tool], owner, run.id);
  assert.equal(state.status, 'awaiting_approval');
  const action = state.actions[0];
  assert.deepEqual(action.target, { studioId: 'studio-a' });
  await rejected(reviewAgentAction(db, { ownerId: 'stranger', runId: run.id, actionId: action.id, digest: action.digest, approve: true }), 'not_found');
  await rejected(reviewAgentAction(db, { ownerId: owner, runId: run.id, actionId: action.id, digest: '0'.repeat(64), approve: true }), 'conflict');
  await advanceAgentRun(db, model(), [tool], owner, run.id);
  assert.equal(executed, 0);
  await approve(db, run.id);
  await rejected(approve(db, run.id), 'conflict');
  state = await advanceAgentRun(db, model(), [tool], owner, run.id);
  assert.equal(state.actions[0].status, 'succeeded'); assert.equal(executed, 1);
});

test('changed tool version or Studio connection invalidates an approval', async (t) => {
  const { db, run } = await setup(t);
  const tool = fixture('execute', 'studio', async () => assert.fail('must not execute'));
  await advanceAgentRun(db, model(), [tool], owner, run.id);
  await approve(db, run.id);
  const state = await advanceAgentRun(db, model(), [{ ...tool, version: 'different-studio' }], owner, run.id);
  assert.equal(state.status, 'failed'); assert.equal(state.actions[0].status, 'failed');
});

test('project write delegation never delegates Studio writes', async (t) => {
  const { db, run } = await setup(t, { autoProjectWrites: true });
  const local = fixture('write');
  assert.equal((await advanceAgentRun(db, model(), [local], owner, run.id)).status, 'ready');
  await advanceAgentRun(db, model(), [local], owner, run.id);
  const state = await advanceAgentRun(db, model(), [fixture('write', 'studio')], owner, run.id);
  assert.equal(state.status, 'awaiting_approval');
});

test('unknown tools, injected identity, invalid decisions and paid models cannot execute', async (t) => {
  const { db, project, run } = await setup(t);
  const tool = fixture('read', 'project', async () => assert.fail('must not execute'));
  await rejected(advanceAgentRun(db, { ...model(), mode: 'paid' }, [tool], owner, run.id), 'unavailable');
  assert.equal((await readAgentRun(db, owner, run.id)).steps, 0);
  for (const decision of [{ ...call, tool: 'grant_credits' }, { ...call, input: { value: 'x', ownerId: 'stranger' } }, { ...call, approve: true }]) {
    const other = await createAgentRun(db, { ownerId: owner, projectId: project.id, objective: 'Test', allowedTools: ['fixture'] });
    const state = await runAgentToCheckpoint(db, model(async () => decision), [tool], owner, other.id);
    assert.equal(state.status, 'failed'); assert.equal(state.actions.length, 0);
  }
});

test('step limits terminate repetitive tool calls', async (t) => {
  const { db, run } = await setup(t, { maxSteps: 2 });
  let executed = 0;
  const state = await runAgentToCheckpoint(db, model(), [fixture('read', 'public', async () => { executed++; return {}; })], owner, run.id);
  assert.equal(state.status, 'failed'); assert.equal(state.error_code, 'step_limit');
  assert.equal(executed, 2); assert.equal(state.steps, 2);
});

test('mutation failures remain uncertain and never automatically retry', async (t) => {
  const { db, run } = await setup(t, { autoProjectWrites: true });
  let executed = 0;
  const tool = fixture('write', 'project', async () => { executed++; throw new Error('secret upstream body'); });
  const state = await runAgentToCheckpoint(db, model(), [tool], owner, run.id);
  assert.equal(state.status, 'uncertain'); assert.equal(state.actions[0].error_code, 'reconciliation_required');
  assert.ok(!JSON.stringify(state).includes('secret upstream body'));
  await runAgentToCheckpoint(db, model(), [tool], owner, run.id);
  assert.equal(executed, 1);
  await rejected(deleteAgentRun(db, owner, run.id), 'conflict');
});

test('cancelling a mutation keeps uncertainty and discards late completion', async (t) => {
  const { db, run } = await setup(t, { autoProjectWrites: true });
  let started, finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const tool = fixture('write', 'project', async () => { started(); return pending; });
  await advanceAgentRun(db, model(), [tool], owner, run.id);
  const execution = advanceAgentRun(db, model(), [tool], owner, run.id);
  await entered;
  assert.equal((await cancelAgentRun(db, owner, run.id)).status, 'uncertain');
  finish({ done: true });
  assert.equal((await execution).status, 'uncertain');
  assert.equal((await readAgentRun(db, owner, run.id)).actions[0].result, null);
});

test('cancelled model calls cannot resurrect the run with a late proposal', async (t) => {
  const { db, run } = await setup(t);
  let started, finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const execution = advanceAgentRun(db, model(async () => { started(); return pending; }), [fixture()], owner, run.id);
  await entered;
  await cancelAgentRun(db, owner, run.id);
  finish(call);
  const state = await execution;
  assert.equal(state.status, 'cancelled'); assert.equal(state.actions.length, 0);
});

test('expired durable claims require recovery and never rerun uncertain mutations', async (t) => {
  const { db, run } = await setup(t, { autoProjectWrites: true });
  await advanceAgentRun(db, model(), [fixture('write')], owner, run.id);
  await db.query("UPDATE agent_runs SET status='running',claimed_at=now() WHERE id=$1", [run.id]);
  await rejected(recoverInterruptedRun(db, owner, run.id), 'conflict');
  await db.query("UPDATE agent_runs SET claimed_at=now()-interval '3 minutes' WHERE id=$1", [run.id]);
  await db.query("UPDATE agent_actions SET status='running' WHERE run_id=$1", [run.id]);
  await recoverInterruptedRun(db, owner, run.id);
  assert.equal((await readAgentRun(db, owner, run.id)).status, 'uncertain');
});

test('project tools preserve boundaries and do not expose consent controls', async (t) => {
  const { db, project, run } = await setup(t);
  const tools = projectTools(db);
  const c = { ownerId: owner, projectId: project.id, runId: run.id, actionId: run.id, signal: new AbortController().signal };
  const tool = (name) => tools.find((item) => item.name === name);
  assert.ok(!tools.some((item) => /approve|share|grant|execute_luau|consent/.test(item.name)));
  assert.equal((await tool('project_context').execute({}, c)).context.game, context.game);
  assert.deepEqual(await tool('project_inventory').execute({}, c), { ui: [], workflows: [], assets: [] });
  assert.throws(() => tool('create_creative_brief').parse({ ownerId: 'stranger' }));
  const other = await createCreativeProject(db, { ownerId: owner, name: 'Second', context });
  const layout = { version: 1, name: 'Fixture', nodes: [{ id: 'root', parentId: null, className: 'Frame', name: 'Root', position: { xScale: 0, xOffset: 0, yScale: 0, yOffset: 0 }, size: { xScale: 1, xOffset: 0, yScale: 1, yOffset: 0 }, anchorPoint: { x: 0, y: 0 }, backgroundColor: [0, 0, 0], backgroundTransparency: 0, zIndex: 1 }] };
  const entry = await createUiEntry(db, owner, other.id, { title: 'Private', description: '', tags: [], layout, assets: {} });
  await rejected(tool('read_ui').execute({ entryId: entry.id }, c), 'not_found');
  await rejected(tool('export_ui').execute({ entryId: entry.id, assetIds: {} }, c), 'not_found');
});

test('oversized tool results fail without storing the private payload', async (t) => {
  const { db, run } = await setup(t);
  const state = await runAgentToCheckpoint(db, model(), [fixture('read', 'project', async () => ({ secret: 'x'.repeat(70000) }))], owner, run.id);
  assert.equal(state.status, 'failed'); assert.equal(state.actions[0].result, null);
});

test('an agent can create a private UI draft, inspect it and export real Luau without publishing', async (t) => {
  const { db, run } = await setup(t, { allowedTools: ['create_ui', 'read_ui', 'export_ui'], autoProjectWrites: true });
  const draft = { title: 'Play panel', description: '', tags: ['menu'], assets: {}, layout: { version: 1, name: 'Play', nodes: [{ id: 'play', parentId: null, className: 'TextButton', name: 'Play', text: 'Play', position: { xScale: 0.5, xOffset: 0, yScale: 0.5, yOffset: 0 }, size: { xScale: 0, xOffset: 200, yScale: 0, yOffset: 60 }, anchorPoint: { x: 0.5, y: 0.5 }, backgroundColor: [20, 20, 20], backgroundTransparency: 0, zIndex: 1 }] } };
  let step = 0;
  const state = await runAgentToCheckpoint(db, model(async ({ observations }) => {
    if (step++ === 0) return { kind: 'tool', tool: 'create_ui', input: draft, reason: 'Save the native layout' };
    const entryId = observations[0].result.id;
    if (step === 2) return { kind: 'tool', tool: 'read_ui', input: { entryId }, reason: 'Inspect the saved draft' };
    if (step === 3) return { kind: 'tool', tool: 'export_ui', input: { entryId, assetIds: {} }, reason: 'Export the native controls' };
    assert.equal(observations.at(-1).result.implemented, false);
    assert.ok(observations.at(-1).result.source.includes('Instance.new("TextButton")'));
    return { kind: 'final', text: 'The UI export is ready. It has not been applied in Studio.' };
  }), projectTools(db), owner, run.id);
  assert.equal(state.status, 'completed');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM ui_library_entries WHERE state='shared'")).rows[0].n, 0);
});

test('rejection cancels a proposed mutation and changed inputs cannot reuse an approval', async (t) => {
  const { db, project, run } = await setup(t);
  const tool = fixture('write', 'project', async () => assert.fail('must not execute'));
  let state = await advanceAgentRun(db, model(), [tool], owner, run.id);
  let action = state.actions[0];
  await reviewAgentAction(db, { ownerId: owner, runId: run.id, actionId: action.id, digest: action.digest, approve: false });
  assert.equal((await advanceAgentRun(db, model(), [tool], owner, run.id)).status, 'cancelled');
  const next = await createAgentRun(db, { ownerId: owner, projectId: project.id, objective: 'Test', allowedTools: ['fixture'] });
  state = await advanceAgentRun(db, model(), [tool], owner, next.id);
  action = state.actions[0];
  await approve(db, next.id);
  // Simulates changed persisted arguments: the old digest must no longer work.
  await db.query('UPDATE agent_actions SET input=$2 WHERE id=$1', [action.id, JSON.stringify({ value: 'Changed after review' })]);
  assert.equal((await advanceAgentRun(db, model(), [tool], owner, next.id)).status, 'failed');
});
