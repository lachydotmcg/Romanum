import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createLocalAgentApi } from '../src/lib/agent-api/index.ts';
import { createMockTool, createScriptedModel } from '../src/lib/agent-api/mock.ts';
import { createAgentRun, readAgentRun, reviewAgentAction } from '../src/lib/harness/runner.ts';
import { agentFixture } from '../scripts/fixtures/agent-api.mjs';

const request = projectId => ({ version: 1, projectId, objective: 'Read fixture tasks.', allowedTools: ['read_project'] });
const call = { kind: 'tool', tool: 'read_project', input: {}, reason: 'Read fixture tasks.' };
const final = { kind: 'final', text: 'Fixture complete.' };
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const eventTypes = execution => execution.events.map(event => event.type);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t) {
  const fixture = await agentFixture();
  t.after(() => fixture.database.close());
  const api = (overrides = {}) => createLocalAgentApi({
    enabled: true, database: fixture.database, ownerId: fixture.ownerId,
    model: fixture.model, tools: [fixture.tool], ...overrides,
  });
  return { ...fixture, api };
}

test('job fixture executes through the existing runner with actual stored observations and ordered events', async t => {
  const { api, database, project, ownerId } = await setup(t);
  const client = api();
  const created = await client.create(request(project.id));
  assert.equal(created.status, 'ready');
  assert.equal(created.maxSteps, 12);
  const execution = await client.run(created.jobId);
  assert.equal(execution.job.status, 'completed');
  assert.equal(execution.job.steps, 2);
  assert.equal(execution.job.output, 'Local test fixture has 1 open task(s): Review first-session instructions.');
  assert.equal(execution.job.actions[0].status, 'succeeded');
  assert.deepEqual(eventTypes(execution), [
    'job.started', 'model.started', 'model.returned', 'tool.started',
    'tool.returned', 'model.started', 'model.returned', 'job.checkpoint',
  ]);
  assert.deepEqual(execution.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(execution.events.map(event => event.executionId)).size, 1);
  assert.ok(execution.events.every(event => event.version === 1 && event.jobId === created.jobId));
  const stored = await readAgentRun(database, ownerId, created.jobId);
  assert.equal(stored.auto_project_writes, false);
  assert.equal(stored.actions[0].result.source, 'local_test_fixture');
  assert.deepEqual(await client.read(created.jobId), execution.job);
  const repeated = await client.run(created.jobId);
  assert.deepEqual(eventTypes(repeated), ['job.started', 'job.checkpoint']);
  assert.notEqual(repeated.events[0].executionId, execution.events[0].executionId);
  assert.deepEqual(await client.cancel(created.jobId), execution.job);
});

test('disabled and paid adapters are rejected before database, model or tool access', async () => {
  const blocked = () => assert.fail('Disabled API touched a dependency.');
  const database = { query: blocked, exec: blocked, transaction: blocked, close: blocked };
  for (const options of [{}, { enabled: true, mode: 'paid' }]) {
    const api = createLocalAgentApi({
      database, ownerId: 'fixture', tools: [], enabled: options.enabled,
      model: { id: 'blocked', mode: options.mode ?? 'test', next: blocked },
    });
    await rejected(api.create({}), 'unavailable');
    await rejected(api.read('bad'), 'unavailable');
    await rejected(api.run('bad'), 'unavailable');
    await rejected(api.cancel('bad'), 'unavailable');
  }
});

test('strict versioned requests reject identity, delegation, unknown tools and out-of-bound steps before creating jobs', async t => {
  const { api, database, project } = await setup(t);
  const client = api();
  for (const extra of [
    { version: 2 }, { ownerId: 'other' }, { autoProjectWrites: true },
    { approved: true }, { allowedTools: ['grant_credits'] },
    { allowedTools: ['read_project', 'read_project'] }, { maxSteps: 0 }, { maxSteps: 21 },
  ]) await rejected(client.create({ ...request(project.id), ...extra }), 'invalid');
  assert.equal((await database.query('SELECT count(*)::int AS count FROM agent_runs')).rows[0].count, 0);
});

test('owner binding applies to job creation, reads, execution and cancellation', async t => {
  const { api, project } = await setup(t);
  const created = await api().create(request(project.id));
  const stranger = api({ ownerId: 'stranger' });
  await rejected(stranger.create(request(project.id)), 'not_found');
  await rejected(stranger.read(created.jobId), 'not_found');
  await rejected(stranger.run(created.jobId), 'not_found');
  await rejected(stranger.cancel(created.jobId), 'not_found');
  assert.equal((await api().read(created.jobId)).status, 'ready');
});

test('unknown, unpermitted and malformed model tool decisions fail without tool execution', async t => {
  const { api, project, tool } = await setup(t);
  for (const decision of [
    { ...call, tool: 'grant_credits' }, { ...call, tool: 'registered_but_denied' },
    { ...call, input: { ownerId: 'stranger' } }, { ...call, approved: true },
  ]) {
    const client = api({ model: createScriptedModel([() => decision]), tools: [
      { ...tool, execute: async () => assert.fail('Must not execute.') },
      { ...tool, name: 'registered_but_denied', execute: async () => assert.fail('Unpermitted tool executed.') },
    ] });
    const created = await client.create(request(project.id));
    const result = await client.run(created.jobId);
    assert.equal(result.job.status, 'failed');
    assert.equal(result.job.errorCode, 'step_failed');
    assert.equal(result.job.actions.length, 0);
    assert.ok(!eventTypes(result).includes('tool.started'));
  }
});

test('tool and provider failures are actionable generic statuses without raw error bodies', async t => {
  const { api, project, tool } = await setup(t);
  const failure = async () => { throw new Error('secret upstream body token-123'); };
  for (const failingTool of [false, true]) {
    const client = api({
      model: createScriptedModel(failingTool ? [call] : [failure]),
      tools: [{ ...tool, execute: failure }],
    });
    const created = await client.create(request(project.id));
    const result = await client.run(created.jobId);
    assert.equal(result.job.status, 'failed');
    assert.equal(result.job.errorCode, 'step_failed');
    assert.equal(result.events.at(-2).type, failingTool ? 'tool.failed' : 'model.failed');
    assert.equal(result.events.at(-2).errorCode, 'adapter_failed');
    if (failingTool) assert.equal(result.job.actions[0].errorCode, 'tool_failed');
    assert.ok(!JSON.stringify(result).includes('secret upstream'));
    assert.ok(!JSON.stringify(result).includes('token-123'));
  }
});

test('step bound terminates a repetitive read workflow without an extra model call', async t => {
  const { api, project } = await setup(t);
  const client = api({ model: createScriptedModel([call, call, () => assert.fail('Exceeded model bound.')]) });
  const created = await client.create({ ...request(project.id), maxSteps: 2 });
  const result = await client.run(created.jobId);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.errorCode, 'step_limit');
  assert.equal(result.job.steps, 2);
  assert.equal(result.job.actions.length, 2);
  assert.equal(eventTypes(result).filter(type => type === 'model.started').length, 2);
});

test('project writes and Studio execution pause for separate exact-action approval', async t => {
  const { api, project } = await setup(t);
  for (const metadata of [{ scope: 'project', effect: 'write' }, { scope: 'studio', effect: 'execute', target: { studioId: 'fixture-studio' } }]) {
    const tool = createMockTool({ ...metadata, name: 'read_project', schema: z.object({}).strict(), execute: async () => assert.fail('Unapproved mutation executed.') });
    const client = api({ model: createScriptedModel([call]), tools: [tool] });
    const created = await client.create(request(project.id));
    const result = await client.run(created.jobId);
    assert.equal(result.job.status, 'awaiting_approval');
    assert.equal(result.job.actions[0].status, 'proposed');
    assert.ok(!eventTypes(result).includes('tool.started'));
    assert.deepEqual(eventTypes(await client.run(created.jobId)), ['job.started', 'job.checkpoint']);
    assert.equal((await client.cancel(created.jobId)).status, 'cancelled');
  }
});

test('facade does not adopt existing runs with broader automatic-write delegation', async t => {
  const { api, database, project, ownerId } = await setup(t);
  const stored = await createAgentRun(database, {
    ownerId, projectId: project.id, objective: 'Existing delegated fixture',
    allowedTools: ['read_project'], autoProjectWrites: true,
  });
  await rejected(api().run(stored.id), 'invalid');
  assert.equal((await readAgentRun(database, ownerId, stored.id)).steps, 0);
});

test('pre-aborted jobs cancel durably without calling the model; direct cancel is idempotent', async t => {
  const { api, project } = await setup(t);
  const client = api({ model: createScriptedModel([() => assert.fail('Pre-aborted model called.')]) });
  const created = await client.create(request(project.id));
  const controller = new AbortController(); controller.abort();
  const result = await client.run(created.jobId, { signal: controller.signal });
  assert.equal(result.job.status, 'cancelled');
  assert.equal(result.job.steps, 0);
  assert.deepEqual(eventTypes(result), ['job.started', 'job.checkpoint']);
  assert.equal((await client.cancel(created.jobId)).status, 'cancelled');
  assert.deepEqual(eventTypes(await client.run(created.jobId)), ['job.started', 'job.checkpoint']);
});

test('abort during the final status read returns the durable cancellation checkpoint', async t => {
  const fixture = await setup(t);
  const controller = new AbortController();
  let modelReturned = false, reads = 0;
  const database = {
    ...fixture.database,
    async query(text, values) {
      const result = await fixture.database.query(text, values);
      // Runner's post-decision read, then facade's final read. Cancellation
      // begins after the latter obtains its otherwise stale approval snapshot.
      if (modelReturned && text.startsWith('SELECT * FROM agent_runs') && ++reads === 2) controller.abort();
      return result;
    },
  };
  const client = fixture.api({
    database,
    model: createScriptedModel([() => { modelReturned = true; return call; }]),
    tools: [{ ...fixture.tool, effect: 'write', execute: async () => assert.fail('Unapproved write executed.') }],
  });
  const created = await client.create(request(fixture.project.id));
  const result = await client.run(created.jobId, { signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.job.status, 'cancelled');
  assert.equal(result.events.at(-1).status, 'cancelled');
  assert.equal((await client.read(created.jobId)).status, 'cancelled');
});

test('abort interrupts active reasoning and discards a non-cooperative late model response', { timeout: 10000 }, async t => {
  const { api, project } = await setup(t);
  const entered = deferred(), late = deferred();
  let modelSignal;
  const client = api({ model: createScriptedModel([(_input, signal) => { modelSignal = signal; entered.resolve(); return late.promise; }]) });
  const created = await client.create(request(project.id));
  const controller = new AbortController();
  const running = client.run(created.jobId, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  const result = await running;
  assert.equal(modelSignal.aborted, true);
  assert.equal(result.job.status, 'cancelled');
  assert.deepEqual(eventTypes(result), ['job.started', 'model.started', 'job.checkpoint']);
  const eventCount = result.events.length;
  late.resolve(final);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.events.length, eventCount);
  assert.equal((await client.read(created.jobId)).status, 'cancelled');
  assert.equal((await client.read(created.jobId)).output, null);
});

test('direct cancellation of a running read suppresses late tool results and events', { timeout: 10000 }, async t => {
  const { api, project, tool } = await setup(t);
  const entered = deferred(), late = deferred();
  const client = api({ model: createScriptedModel([call, final]), tools: [{ ...tool, execute: () => { entered.resolve(); return late.promise; } }] });
  const created = await client.create(request(project.id));
  const running = client.run(created.jobId);
  await entered.promise;
  assert.equal((await client.cancel(created.jobId)).status, 'cancelled');
  const result = await running;
  assert.equal(result.job.status, 'cancelled');
  assert.equal(result.job.actions[0].status, 'failed');
  const eventCount = result.events.length;
  late.resolve({ confidentialToolPayload: 'must not escape' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.events.length, eventCount);
  assert.ok(!eventTypes(result).includes('tool.returned'));
  assert.ok(!JSON.stringify(result).includes('confidentialToolPayload'));
});

test('cancelling a separately approved running mutation keeps reconciliation uncertainty', { timeout: 10000 }, async t => {
  const { api, database, project, ownerId } = await setup(t);
  const entered = deferred(), late = deferred();
  const tool = createMockTool({ name: 'read_project', effect: 'write', schema: z.object({}).strict(), execute: () => { entered.resolve(); return late.promise; } });
  const client = api({ model: createScriptedModel([call, final]), tools: [tool] });
  const created = await client.create(request(project.id));
  assert.equal((await client.run(created.jobId)).job.status, 'awaiting_approval');
  // Existing trusted owner approval, deliberately absent from the new facade.
  const proposed = await readAgentRun(database, ownerId, created.jobId);
  const action = proposed.actions[0];
  await reviewAgentAction(database, { ownerId, runId: created.jobId, actionId: action.id, digest: action.digest, approve: true });
  const running = client.run(created.jobId);
  await entered.promise;
  const cancelled = await client.cancel(created.jobId);
  assert.equal(cancelled.status, 'uncertain');
  assert.equal(cancelled.errorCode, 'reconciliation_required');
  assert.equal((await running).job.actions[0].status, 'uncertain');
  late.resolve({ done: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await client.run(created.jobId)).job.status, 'uncertain');
});

test('wire projection omits context, tool payloads, approval digests and claims', async t => {
  const { api, project, tool } = await setup(t);
  const client = api({ model: createScriptedModel([call, final]), tools: [{ ...tool, execute: async () => ({ privatePayload: 'fixture-secret' }) }] });
  const created = await client.create(request(project.id));
  const result = await client.run(created.jobId);
  assert.deepEqual(Object.keys(result.job).sort(), ['actions', 'errorCode', 'jobId', 'maxSteps', 'output', 'projectId', 'status', 'steps', 'version', 'waitingForJobId']);
  assert.deepEqual(Object.keys(result.job.actions[0]).sort(), ['actionId', 'effect', 'errorCode', 'scope', 'sequence', 'status', 'tool']);
  for (const omitted of ['fixture-secret', 'privatePayload', 'owner_id', 'claim_id', 'digest', 'artDirection']) assert.ok(!JSON.stringify(result).includes(omitted));
});

test('infrastructure errors use a generic boundary error', async () => {
  const api = createLocalAgentApi({
    enabled: true, ownerId: 'fixture', tools: [], model: createScriptedModel([]),
    database: { query: async () => { throw new Error('postgres://secret:password@host'); } },
  });
  await assert.rejects(api.read('00000000-0000-4000-8000-000000000000'), error => error.code === 'unavailable' && !error.message.includes('password'));
});
