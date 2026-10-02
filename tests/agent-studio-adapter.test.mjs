import test from 'node:test';
import assert from 'node:assert/strict';
import { MockStudioTransport } from '../packages/studio-bridge/fixtures/mock-studio.ts';
import { createMockStudioJobAdapter } from '../src/lib/agent-api-studio-adapter/index.ts';
import { createScriptedModel } from '../src/lib/agent-api/mock.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { createAgentRun } from '../src/lib/harness/runner.ts';
import { studioJobFixture, proposedWrite, approveRunner, studioRequest, readDecision } from '../scripts/fixtures/agent-studio-mock.mjs';

const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const tick = () => new Promise(resolve => setImmediate(resolve));
const writeCalls = fixture => fixture.transport.toolCalls.filter(call => call.params.name === 'multi_edit');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t, options) {
  const fixture = await studioJobFixture(options);
  t.after(async () => { fixture.adapter.close(); await fixture.database.close(); });
  return fixture;
}
async function approveBoth(fixture, review) {
  await approveRunner(fixture, review);
  await fixture.adapter.reviewBridge(review.runId, review.bridge.actionId, review.bridge.digest, true);
}

test('selected mock Studio is discovered, its instance is read, and only two exact reviews permit a write', async t => {
  const fixture = await setup(t);
  const { adapter } = fixture;
  const { created, checkpoint, review } = await proposedWrite(fixture);
  assert.equal(adapter.target.studioId, 'studio-b');
  assert.deepEqual(adapter.discovery.capabilities.map(capability => capability.name), ['get_studio_state', 'multi_edit']);
  assert.ok(adapter.tools.every(tool => !JSON.stringify(tool.inputSchema).includes('studio_id')));
  assert.equal(checkpoint.job.actions[0].status, 'succeeded');
  assert.equal(review.bridge.target.studioId, 'studio-b');
  assert.equal(review.bridge.actionId, checkpoint.job.actions[1].actionId);
  assert.notEqual(review.runnerDigest, review.bridge.digest);
  assert.equal(fixture.instance.source, "return 'red'");
  await approveRunner(fixture, review);
  await rejected(adapter.run(created.jobId), 'review_required');
  assert.equal((await adapter.api.read(created.jobId)).status, 'ready');
  assert.equal(writeCalls(fixture).length, 0);
  await adapter.reviewBridge(created.jobId, review.bridge.actionId, review.bridge.digest, true);
  const result = await adapter.run(created.jobId);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.steps, 3);
  assert.equal(fixture.transport.writes.length, 1);
  assert.equal(fixture.instance.source, "return 'blue'");
  assert.equal(result.job.output, "Mock-only edit observed: return 'red' -> return 'blue'. No live Studio was accessed.");
  assert.ok(fixture.transport.toolCalls.filter(call => call.params.name !== 'list_roblox_studios').every(call => call.params.arguments.studio_id === 'studio-b'));
  await adapter.run(created.jobId);
  assert.equal(writeCalls(fixture).length, 1);
});

test('bridge approval alone leaves the runner paused; returned proposals cannot alter stored review', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  const digest = review.bridge.digest;
  review.bridge.input.edits[0].newText = 'forged';
  review.bridge.target.studioId = 'studio-a';
  const stored = await fixture.adapter.prepareWrite(created.jobId, review.bridge.actionId);
  assert.equal(stored.bridge.input.edits[0].newText, 'blue');
  assert.equal(stored.bridge.target.studioId, 'studio-b');
  await fixture.adapter.reviewBridge(created.jobId, review.bridge.actionId, digest, true);
  assert.equal((await fixture.adapter.run(created.jobId)).job.status, 'awaiting_approval');
  assert.equal(writeCalls(fixture).length, 0);
});

test('runner digest, guessed digest, duplicate review and denial never approve a bridge write', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  for (const digest of [review.runnerDigest, '0'.repeat(64)]) await rejected(fixture.adapter.reviewBridge(created.jobId, review.bridge.actionId, digest, true), 'review_mismatch');
  await approveRunner(fixture, review);
  await fixture.adapter.reviewBridge(created.jobId, review.bridge.actionId, review.bridge.digest, false);
  await rejected(fixture.adapter.reviewBridge(created.jobId, review.bridge.actionId, review.bridge.digest, true), 'review_mismatch');
  await rejected(fixture.adapter.run(created.jobId), 'write_denied');
  assert.equal((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).status, 'rejected');
  assert.equal(writeCalls(fixture).length, 0);
});

test('approval expiry is checked on review and again on execution; preparing again cannot refresh it', async t => {
  let clock = 1000;
  const fixture = await setup(t, { approvalTtlMs: 100, now: () => clock });
  const first = await proposedWrite(fixture);
  clock = first.review.expiresAt;
  await rejected(fixture.adapter.reviewBridge(first.created.jobId, first.review.bridge.actionId, first.review.bridge.digest, true), 'approval_expired');
  assert.equal((await fixture.adapter.prepareWrite(first.created.jobId, first.review.bridge.actionId)).expiresAt, first.review.expiresAt);
  await approveRunner(fixture, first.review);
  await rejected(fixture.adapter.run(first.created.jobId), 'approval_expired');
  assert.equal(writeCalls(fixture).length, 0);
});

test('previously granted exact approval expires before a later execution', async t => {
  let clock = 2000;
  const fixture = await setup(t, { approvalTtlMs: 100, now: () => clock });
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  clock = review.expiresAt + 1;
  await rejected(fixture.adapter.run(created.jobId), 'approval_expired');
  assert.equal(writeCalls(fixture).length, 0);
});

test('unknown selection and model-controlled Studio identity dispatch no instance action', async t => {
  const fixture = await setup(t, { model: createScriptedModel([{ ...readDecision, input: { studio_id: 'studio-a' } }]) });
  const created = await fixture.adapter.api.create(studioRequest(fixture.project.id));
  assert.equal((await fixture.adapter.run(created.jobId)).job.status, 'failed');
  assert.equal(fixture.transport.toolCalls.filter(call => call.params.name === 'get_studio_state').length, 0);
  const transport = new MockStudioTransport();
  await rejected(createMockStudioJobAdapter({
    enabled: true, database: fixture.database, ownerId: fixture.ownerId,
    projectId: fixture.project.id, studioId: 'not-present', model: createScriptedModel([]), transport,
  }), 'wrong_studio');
  assert.equal(transport.closed, true);
});

test('owner/project binding and trusted action IDs prevent another run from reviewing or executing', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  const other = await createCreativeProject(fixture.database, { ownerId: fixture.ownerId, name: 'Other fixture', context: { game: 'Other fixture' } });
  const otherRun = await createAgentRun(fixture.database, { ownerId: fixture.ownerId, projectId: other.id, objective: 'Other project', allowedTools: ['studio_multi_edit'] });
  await rejected(fixture.adapter.run(otherRun.id), 'not_found');
  await rejected(fixture.adapter.reviewBridge(otherRun.id, review.bridge.actionId, review.bridge.digest, true), 'not_found');
  const strangerRun = await createAgentRun(fixture.database, { ownerId: fixture.ownerId, projectId: fixture.project.id, objective: 'Same project other run', allowedTools: ['studio_multi_edit'] });
  await rejected(fixture.adapter.reviewBridge(strangerRun.id, review.bridge.actionId, review.bridge.digest, true), 'not_found');
  const tool = fixture.adapter.tools.find(tool => tool.effect === 'write');
  await rejected(tool.execute(review.bridge.input, { ownerId: 'stranger', projectId: fixture.project.id, runId: created.jobId, actionId: review.bridge.actionId, signal: new AbortController().signal }), 'not_found');
  assert.equal(writeCalls(fixture).length, 0);
});

test('changed selected Studio metadata prevents dispatch and preserves the bridge outcome', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  fixture.transport.sessions[1].place_id = '999';
  const result = await fixture.adapter.run(created.jobId);
  assert.equal(result.job.status, 'uncertain');
  assert.deepEqual((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).lastFailure, { code: 'wrong_studio', outcome: 'not_dispatched' });
  assert.equal(writeCalls(fixture).length, 0);
});

test('pre-dispatch cancellation durably cancels without a write, even with both approvals', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  const controller = new AbortController(); controller.abort();
  assert.equal((await fixture.adapter.run(created.jobId, { signal: controller.signal })).job.status, 'cancelled');
  assert.equal(writeCalls(fixture).length, 0);
  assert.equal((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).status, 'approved');
});

test('cancellation during refresh is not dispatched; conservative runner uncertainty remains', { timeout: 15000 }, async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  const entered = deferred();
  fixture.transport.hold.add('tools/list');
  const send = fixture.transport.send.bind(fixture.transport);
  fixture.transport.send = message => { send(message); if (message.method === 'tools/list') entered.resolve(); };
  const running = fixture.adapter.run(created.jobId);
  await entered.promise;
  await fixture.adapter.api.cancel(created.jobId);
  const result = await running;
  await tick();
  assert.equal(result.job.status, 'uncertain');
  assert.equal(writeCalls(fixture).length, 0);
  assert.deepEqual((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).lastFailure, { code: 'cancelled', outcome: 'not_dispatched' });
});

test('cancellation after dispatch leaves uncertainty; late responses never cause a replay', { timeout: 15000 }, async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  const dispatched = deferred();
  fixture.transport.hold.add('multi_edit');
  fixture.transport.onActionDispatch = request => { if (request.params.name === 'multi_edit') dispatched.resolve(request); };
  const controller = new AbortController();
  const running = fixture.adapter.run(created.jobId, { signal: controller.signal });
  const request = await dispatched.promise;
  controller.abort();
  assert.equal((await running).job.status, 'uncertain');
  await tick();
  const evidence = await fixture.adapter.evidence(created.jobId, review.bridge.actionId);
  assert.equal(evidence.status, 'uncertain');
  assert.deepEqual(evidence.lastFailure, { code: 'cancelled', outcome: 'unknown' });
  fixture.transport.emit({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { mock: true, applied: true }, content: [] } });
  await tick();
  assert.equal((await fixture.adapter.run(created.jobId)).job.status, 'uncertain');
  assert.equal(writeCalls(fixture).length, 1);
  assert.equal(fixture.transport.writes.length, 0);
});

test('a write applied in fixture memory but reported as an error stays uncertain with no retry', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveBoth(fixture, review);
  const reply = fixture.transport.replyOverride;
  fixture.transport.replyOverride = request => {
    const result = reply(request);
    if (request.method === 'tools/call' && request.params.name === 'multi_edit') return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'secret fixture upstream details' } };
    return result;
  };
  const result = await fixture.adapter.run(created.jobId);
  assert.equal(result.job.status, 'uncertain');
  assert.equal(fixture.instance.source, "return 'blue'");
  assert.deepEqual((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).lastFailure, { code: 'remote_error', outcome: 'unknown' });
  assert.ok(!JSON.stringify(result).includes('secret fixture upstream details'));
  assert.equal((await fixture.adapter.run(created.jobId)).job.status, 'uncertain');
  assert.equal(fixture.transport.writes.length, 1);
  assert.equal(writeCalls(fixture).length, 1);
});

test('bypassing the guarded run still cannot turn runner approval into bridge approval', async t => {
  const fixture = await setup(t);
  const { created, review } = await proposedWrite(fixture);
  await approveRunner(fixture, review);
  assert.equal((await fixture.adapter.api.run(created.jobId)).job.status, 'uncertain');
  assert.equal((await fixture.adapter.evidence(created.jobId, review.bridge.actionId)).status, 'proposed');
  assert.equal(writeCalls(fixture).length, 0);
});

test('disabled, paid or non-mock wiring fails before touching dependencies', async () => {
  const fail = () => assert.fail('Disabled fixture touched a dependency.');
  for (const options of [{ enabled: false }, { enabled: true, mode: 'paid' }, { enabled: true, transport: {} }]) {
    await rejected(createMockStudioJobAdapter({
      enabled: options.enabled, model: { id: 'fixture', mode: options.mode ?? 'test', next: fail },
      database: { query: fail }, ownerId: 'fixture', projectId: 'invalid', studioId: 'fixture',
      transport: options.transport ?? new MockStudioTransport(),
    }), 'unavailable');
  }
});
