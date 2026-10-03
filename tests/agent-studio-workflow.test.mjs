import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureStudioWorkflow } from '../src/lib/agent-api-studio-workflow/service.ts';
import { studioWorkflowResponse } from '../src/lib/agent-api-studio-workflow/http.ts';
import { MockStudioTransport } from '../packages/studio-bridge/fixtures/mock-studio.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { workflowFixture, reviewedWorkflow, fixtureEdit } from '../scripts/fixtures/agent-studio-workflow.mjs';

async function setup(t, options) { const fixture = await workflowFixture(options); t.after(() => fixture.close()); return fixture; }
const writeCalls = fixture => fixture.transport.toolCalls.filter(call => call.params.name === 'multi_edit');
async function waitFor(predicate) {
  for (let count = 0; count < 200; count++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Fixture checkpoint was not reached.');
}
const readRequest = (projectId, actionId) => new Request(`https://romanum.test/api/agent-studio-fixture?projectId=${projectId}${actionId ? `&actionId=${actionId}` : ''}`);

test('authenticated inspect/review/execute persists exact selected target and replays without another write', async t => {
  const fixture = await setup(t);
  const { selected, inspected, proposed, review, actionId } = await reviewedWorkflow(fixture);
  for (const response of [selected, inspected, proposed, review]) assert.equal(response.status, 200);
  assert.equal(inspected.body.result.result.structuredContent.source, "return 'red'");
  assert.equal(proposed.body.result.inspectionId, inspected.body.result.actionId);
  assert.equal(proposed.body.result.proposal.target.studioId, 'studio-b');
  assert.equal(proposed.body.result.status, 'proposed');
  assert.equal(review.body.result.status, 'approved');
  assert.notEqual(proposed.body.result.digest, proposed.body.result.proposal.digest);
  assert.equal(fixture.instance.source, "return 'red'");
  const first = await fixture.send('execute', { actionId });
  const again = await fixture.send('execute', { actionId });
  assert.deepEqual(again.body, first.body);
  assert.equal(first.body.result.status, 'succeeded');
  assert.equal(fixture.instance.source, "return 'blue'");
  assert.equal(writeCalls(fixture).length, 1);
  const response = await studioWorkflowResponse(readRequest(fixture.project.id, actionId), fixture.deps);
  assert.equal(response.status, 200);
  const serialized = await response.text();
  for (const privateField of ['claim_id', 'lease_until', 'owner_id', 'request_hash']) assert.ok(!serialized.includes(privateField));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('session required each request; auth failure, cross-site, defaults and service mismatch never dispatch', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  fixture.setAccount(null);
  assert.equal((await fixture.send('execute', { actionId })).status, 401);
  assert.equal((await studioWorkflowResponse(readRequest(fixture.project.id), fixture.deps)).status, 401);
  fixture.setAccount({ ownerId: fixture.ownerId });
  assert.equal((await fixture.send('execute', { actionId }, 'csrf', { ...fixture.deps, isCrossSite: () => true })).status, 403);
  assert.equal((await fixture.send('execute', { actionId }, 'disabled', { ...fixture.deps, enabled: undefined })).status, 503);
  fixture.setAccount({ ownerId: 'foreign-account' });
  assert.equal((await fixture.send('execute', { actionId }, 'foreign', { ...fixture.deps, workflow: async () => fixture.workflow })).status, 503);
  assert.equal(writeCalls(fixture).length, 0);
  const failed = await studioWorkflowResponse(readRequest(fixture.project.id), { ...fixture.deps, account: async () => { throw new Error('secret session connection'); } });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('secret'));
});

test('owner and project scope cover discovery, reads, reviews, execution, cancellation and recovery', async t => {
  const fixture = await setup(t);
  const { actionId, proposed } = await reviewedWorkflow(fixture);
  const foreign = await createCreativeProject(fixture.database, { ownerId: 'foreign', name: 'Foreign fixture', context: { game: 'Foreign fixture' } });
  const mine = await createCreativeProject(fixture.database, { ownerId: fixture.ownerId, name: 'Other fixture', context: { game: 'Other fixture' } });
  for (const projectId of [foreign.id, mine.id]) {
    for (const operation of ['review', 'execute', 'cancel', 'recover']) {
      const fields = { projectId, actionId, ...(operation === 'review' ? { digest: proposed.body.result.digest, approve: true } : {}) };
      assert.equal((await fixture.send(operation, fields, `${operation}:${projectId}`)).status, 404);
    }
    assert.equal((await studioWorkflowResponse(readRequest(projectId, actionId), fixture.deps)).status, 404);
  }
  assert.equal((await studioWorkflowResponse(readRequest(foreign.id), fixture.deps)).status, 404);
  assert.equal(writeCalls(fixture).length, 0);
});

test('strict payloads reject injected owner, Studio, capabilities and unknown operations; streamed bytes are bounded', async t => {
  const fixture = await setup(t);
  for (const fields of [{ ownerId: 'foreign' }, { studio_id: 'studio-a' }, { capability: 'execute_luau' }]) assert.equal((await fixture.send('select', { studioId: 'studio-b', ...fields })).status, 400);
  for (const operation of ['execute_luau', 'publish', 'install', 'pair']) assert.equal((await fixture.send(operation)).status, 400);
  for (const [body, status] of [['{', 400], [' '.repeat(65_537), 413]]) {
    const request = new Request('https://romanum.test/api/agent-studio-fixture', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    assert.equal((await studioWorkflowResponse(request, fixture.deps)).status, status);
  }
  assert.equal((await fixture.database.query('SELECT count(*)::int AS count FROM studio_workflow_selections')).rows[0].count, 0);
});

test('explicit selection and inspection are required; key conflicts cannot retarget old selection', async t => {
  const fixture = await setup(t);
  assert.equal((await fixture.send('select', { studioId: 'missing' })).status, 503);
  const selected = await fixture.send('select', { studioId: 'studio-b' });
  assert.deepEqual((await fixture.send('select', { studioId: 'studio-b' })).body, selected.body);
  assert.equal((await fixture.send('select', { studioId: 'studio-a' })).status, 409);
  const fake = '11111111-1111-4111-8111-111111111111';
  assert.equal((await fixture.send('propose', { inspectionId: fake, input: fixtureEdit })).status, 404);
  assert.equal(writeCalls(fixture).length, 0);
});

test('concurrent identical execution is one durable attempt; a different key cannot execute it again', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  fixture.transport.hold.add('multi_edit');
  const executing = fixture.send('execute', { actionId });
  await waitFor(() => writeCalls(fixture).length === 1);
  const replay = await fixture.send('execute', { actionId });
  assert.equal(replay.body.result.status, 'running');
  assert.equal((await fixture.send('execute', { actionId }, 'different-attempt')).status, 409);
  assert.equal((await fixture.send('cancel', { actionId })).body.result.status, 'uncertain');
  assert.equal((await executing).body.result.status, 'uncertain');
  assert.equal(writeCalls(fixture).length, 1);
  assert.equal((await fixture.send('execute', { actionId })).body.result.status, 'uncertain');
});

test('concurrent inspection retries return the same running action without adopting its claim', async t => {
  const fixture = await setup(t);
  const selected = await fixture.send('select', { studioId: 'studio-b' });
  const selectionId = selected.body.result.selectionId;
  fixture.transport.hold.add('get_studio_state');
  const inspecting = fixture.send('inspect', { selectionId });
  await waitFor(() => fixture.transport.toolCalls.some(call => call.params.name === 'get_studio_state'));
  const replay = await fixture.send('inspect', { selectionId });
  assert.equal(replay.body.result.status, 'running');
  await fixture.send('cancel', { actionId: replay.body.result.actionId });
  assert.equal((await inspecting).body.result.status, 'cancelled');
  assert.equal(fixture.transport.toolCalls.filter(call => call.params.name === 'get_studio_state').length, 1);
});

test('review exactness, denial, idempotency and cancellation prevent dispatch', async t => {
  const fixture = await setup(t);
  const selected = await fixture.send('select', { studioId: 'studio-b' });
  const inspected = await fixture.send('inspect', { selectionId: selected.body.result.selectionId });
  const proposed = await fixture.send('propose', { inspectionId: inspected.body.result.actionId, input: fixtureEdit });
  const actionId = proposed.body.result.actionId, digest = proposed.body.result.digest;
  assert.equal((await fixture.send('execute', { actionId })).status, 409);
  assert.equal((await fixture.send('review', { actionId, digest: proposed.body.result.proposal.digest, approve: true }, 'bad-digest')).status, 409);
  const denied = await fixture.send('review', { actionId, digest, approve: false });
  assert.equal(denied.body.result.status, 'rejected');
  assert.deepEqual((await fixture.send('review', { actionId, digest, approve: false })).body, denied.body);
  assert.equal((await fixture.send('review', { actionId, digest, approve: true })).status, 409);
  assert.equal((await fixture.send('execute', { actionId })).status, 409);
  assert.equal(writeCalls(fixture).length, 0);
});

test('expired approval, project changes and archived projects cannot execute; cancellation stays available', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  await fixture.database.query("UPDATE studio_workflow_actions SET expires_at=now()-interval '1 second' WHERE id=$1", [actionId]);
  assert.equal((await fixture.send('execute', { actionId })).body.error, 'Studio request: approval_expired.');
  await fixture.database.query("UPDATE studio_workflow_actions SET expires_at=now()+interval '1 minute' WHERE id=$1", [actionId]);
  await fixture.database.query('UPDATE creative_projects SET revision=revision+1 WHERE id=$1', [fixture.project.id]);
  assert.equal((await fixture.send('execute', { actionId })).status, 409);
  await fixture.database.query('UPDATE creative_projects SET archived=true WHERE id=$1', [fixture.project.id]);
  assert.equal((await fixture.send('execute', { actionId })).status, 409);
  assert.equal((await fixture.send('cancel', { actionId })).body.result.status, 'cancelled');
  assert.equal(writeCalls(fixture).length, 0);
});

test('reselection invalidates approval without choosing a default or redirecting a write', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  assert.equal((await fixture.send('select', { studioId: 'studio-a' }, 'new-selection')).status, 200);
  assert.equal((await fixture.send('execute', { actionId })).body.error, 'Studio request: stale_selection.');
  assert.equal(writeCalls(fixture).length, 0);
});

test('cancel during discovery is durably not dispatched; late discovery never sends a write', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  fixture.transport.hold.add('tools/list');
  const executing = fixture.send('execute', { actionId });
  await waitFor(async () => (await fixture.workflow.read(fixture.project.id, actionId)).status === 'running');
  const cancelled = await fixture.send('cancel', { actionId });
  assert.equal(cancelled.body.result.status, 'cancelled');
  assert.equal(cancelled.body.result.dispatchPhase, 'pending');
  assert.equal((await executing).body.result.status, 'cancelled');
  assert.equal(writeCalls(fixture).length, 0);
});

test('approval expiry during discovery is checked at the durable dispatch fence', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  const before = fixture.transport.beforeReply;
  let expiry;
  fixture.transport.beforeReply = request => {
    before?.(request);
    if (request.method === 'tools/list') expiry = fixture.database.query("UPDATE studio_workflow_actions SET expires_at=now()-interval '1 second' WHERE id=$1", [actionId]);
  };
  const result = await fixture.send('execute', { actionId });
  await expiry;
  assert.equal(result.body.result.status, 'failed');
  assert.equal(result.body.result.dispatchPhase, 'pending');
  assert.equal(writeCalls(fixture).length, 0);
});

test('recovery respects leases, revokes the claim and fences a still-active worker', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  fixture.transport.hold.add('multi_edit');
  const executing = fixture.send('execute', { actionId });
  await waitFor(() => writeCalls(fixture).length === 1);
  assert.equal((await fixture.send('recover', { actionId })).status, 409);
  await fixture.database.query("UPDATE studio_workflow_actions SET lease_until=now()-interval '1 second' WHERE id=$1", [actionId]);
  const recovered = await fixture.send('recover', { actionId });
  assert.equal(recovered.body.result.status, 'uncertain');
  assert.equal((await executing).body.result.status, 'uncertain');
  assert.equal((await fixture.send('recover', { actionId })).body.result.status, 'uncertain');
  assert.equal((await fixture.send('execute', { actionId })).body.result.status, 'uncertain');
  const durable = (await fixture.database.query('SELECT claim_id,lease_until FROM studio_workflow_actions WHERE id=$1', [actionId])).rows[0];
  assert.deepEqual(durable, { claim_id: null, lease_until: null });
  assert.equal(writeCalls(fixture).length, 1);
});

test('applied mutation followed by a remote error remains uncertain and is never replayed', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  const normal = fixture.transport.replyOverride;
  fixture.transport.replyOverride = request => {
    const response = normal(request);
    return request.method === 'tools/call' && request.params.name === 'multi_edit' ? { jsonrpc: '2.0', id: request.id, result: { isError: true, content: [] } } : response;
  };
  const executed = await fixture.send('execute', { actionId });
  assert.equal(executed.body.result.status, 'uncertain');
  assert.equal(fixture.instance.source, "return 'blue'");
  await fixture.send('execute', { actionId });
  assert.equal(fixture.transport.writes.length, 1);
  const selected = await fixture.send('select', { studioId: 'studio-b' }, 'new-selection');
  const inspected = await fixture.send('inspect', { selectionId: selected.body.result.selectionId }, 'new-inspection');
  assert.equal(inspected.body.result.status, 'succeeded');
  assert.equal((await fixture.send('propose', { inspectionId: inspected.body.result.actionId, input: fixtureEdit }, 'new-write')).status, 409);
  assert.equal(writeCalls(fixture).length, 1);
});

test('a completion-storage failure leaves a durable attempt; redelivery and recovery never repeat the applied write', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  const original = fixture.database.transaction;
  fixture.database.transaction = operation => original(sql => operation({ ...sql, query: (text, values) => {
    if (text.startsWith('UPDATE studio_workflow_actions SET status=$2,result=$3')) throw new Error('authored completion-storage failure');
    return sql.query(text, values);
  } }));
  assert.equal((await fixture.send('execute', { actionId })).status, 503);
  fixture.database.transaction = original;
  assert.equal(fixture.instance.source, "return 'blue'");
  assert.equal((await fixture.send('execute', { actionId })).body.result.status, 'running');
  await fixture.database.query("UPDATE studio_workflow_actions SET lease_until=now()-interval '1 second' WHERE id=$1", [actionId]);
  assert.equal((await fixture.send('recover', { actionId })).body.result.status, 'uncertain');
  assert.equal(writeCalls(fixture).length, 1);
});

test('another mutation requires a fresh inspection after a successful write', async t => {
  const fixture = await setup(t);
  const { actionId, inspected, selected } = await reviewedWorkflow(fixture);
  assert.equal((await fixture.send('execute', { actionId })).body.result.status, 'succeeded');
  assert.equal((await fixture.send('propose', { inspectionId: inspected.body.result.actionId, input: fixtureEdit }, 'stale-inspection')).status, 409);
  const fresh = await fixture.send('inspect', { selectionId: selected.body.result.selectionId }, 'fresh-inspection');
  const next = await fixture.send('propose', { inspectionId: fresh.body.result.actionId, input: { datamodel_type: 'Edit', edits: [{ path: 'ServerScriptService.Fixture', oldText: 'blue', newText: 'green' }] } }, 'fresh-write');
  assert.equal(next.body.result.status, 'proposed');
  assert.equal(writeCalls(fixture).length, 1);
});

test('inspection during a running write is stale after that write finishes', async t => {
  const fixture = await setup(t);
  const { actionId, selected } = await reviewedWorkflow(fixture);
  fixture.transport.hold.add('multi_edit');
  const executing = fixture.send('execute', { actionId });
  await waitFor(() => writeCalls(fixture).length === 1);
  const during = await fixture.send('inspect', { selectionId: selected.body.result.selectionId }, 'during-write');
  assert.equal(during.body.result.result.structuredContent.source, "return 'red'");
  const held = writeCalls(fixture)[0];
  fixture.transport.emit(fixture.transport.replyOverride(held));
  assert.equal((await executing).body.result.status, 'succeeded');
  assert.equal((await fixture.send('propose', { inspectionId: during.body.result.actionId, input: fixtureEdit }, 'stale-concurrent-read')).status, 409);
  assert.equal(writeCalls(fixture).length, 1);
});

test('another project and reconnect cannot bypass an uncertain write to the same Studio/place', async t => {
  const fixture = await setup(t);
  const { actionId } = await reviewedWorkflow(fixture);
  fixture.transport.hold.add('multi_edit');
  const executing = fixture.send('execute', { actionId });
  await waitFor(() => writeCalls(fixture).length === 1);
  assert.equal((await fixture.send('cancel', { actionId })).body.result.status, 'uncertain');
  await executing;
  const project = await createCreativeProject(fixture.database, { ownerId: fixture.ownerId, name: 'Same Studio other project', context: { game: 'Same Studio other project' } });
  const transport = new MockStudioTransport();
  const second = await createFixtureStudioWorkflow({ enabled: true, database: fixture.database, ownerId: fixture.ownerId, transport });
  t.after(() => second.close());
  const selected = await second.request({ operation: 'select', projectId: project.id, key: 'select', studioId: 'studio-b' });
  const inspected = await second.request({ operation: 'inspect', projectId: project.id, key: 'inspect', selectionId: selected.selectionId });
  await assert.rejects(second.request({ operation: 'propose', projectId: project.id, key: 'propose', inspectionId: inspected.actionId, input: fixtureEdit }), error => error.code === 'conflict');
  assert.equal(transport.toolCalls.filter(call => call.params.name === 'multi_edit').length, 0);
});

test('SQL records and receipts survive disk reopen; reconnect cannot consume an old approved proposal', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'romanum-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await workflowFixture({ directory });
  const { actionId, proposed, inspected, review } = await reviewedWorkflow(first);
  const projectId = first.project.id;
  await first.close();
  const next = await setup(t, { directory, existingProjectId: projectId });
  assert.equal((await next.workflow.read(projectId, actionId)).digest, proposed.body.result.digest);
  assert.equal((await next.workflow.read(projectId, inspected.body.result.actionId)).status, 'succeeded');
  assert.equal((await next.send('execute', { actionId })).body.error, 'Studio request: stale_selection.');
  assert.deepEqual((await next.send('propose', { inspectionId: inspected.body.result.actionId, input: fixtureEdit })).body.result, review.body.result);
  assert.equal(writeCalls(next).length, 0);
});

test('fixture construction requires explicit enablement and the authored transport; no live activation', async () => {
  await assert.rejects(createFixtureStudioWorkflow({ database: null, ownerId: 'fixture', transport: new MockStudioTransport() }), error => error.code === 'unavailable');
  await assert.rejects(createFixtureStudioWorkflow({ enabled: true, database: null, ownerId: 'fixture', transport: { send() {} } }), error => error.code === 'unavailable');
});
