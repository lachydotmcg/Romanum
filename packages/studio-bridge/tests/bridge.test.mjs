import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioBridge, MCP_VERSION } from '../src/index.ts';
import { MockStudioTransport, validateFixtureInput } from '../fixtures/mock-studio.ts';

const rejects = (promise, code, outcome) => assert.rejects(promise, (error) => error.code === code && (outcome === undefined || error.outcome === outcome));
const throws = (run, code) => assert.throws(run, (error) => error.code === code);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const edits = () => ({ datamodel_type: 'Edit', edits: [{ path: 'game.ServerScriptService.Mock', oldText: 'old', newText: 'new' }] });

async function fixture(t, timeoutMs = 500) {
  const transport = new MockStudioTransport();
  const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput, timeoutMs });
  t.after(() => bridge.close());
  await bridge.initialize();
  const discovery = await bridge.discover();
  const target = bridge.selectStudio('studio-b');
  const prepare = (actionId, tool = 'get_studio_state', input = tool === 'multi_edit' ? edits() : {}) => {
    const capability = discovery.capabilities.find((item) => item.name === tool);
    return bridge.prepareAction({ actionId, target, tool, version: capability?.version ?? 'unsupported', input });
  };
  return { bridge, transport, discovery, target, prepare };
}
const actionCalls = (transport) => transport.toolCalls.filter((call) => call.params.name !== 'list_roblox_studios');

test('negotiates MCP before discovery; only local policy capabilities are exposed', async (t) => {
  const { bridge, transport, discovery, prepare } = await fixture(t);
  assert.equal(transport.messages[0].params.protocolVersion, MCP_VERSION);
  assert.equal(transport.messages[1].method, 'notifications/initialized');
  assert.deepEqual(discovery.capabilities.map(({ name, effect, requiresConfirmation }) => ({ name, effect, requiresConfirmation })), [
    { name: 'get_studio_state', effect: 'read', requiresConfirmation: false },
    { name: 'multi_edit', effect: 'write', requiresConfirmation: true },
  ]);
  throws(() => prepare('execute', 'execute_luau'), 'unknown_tool');
  const action = prepare('read');
  const result = await bridge.execute(action.actionId);
  assert.equal(result.structuredContent.studio_id, 'studio-b');
  assert.equal(actionCalls(transport)[0].params.arguments.studio_id, 'studio-b');
  const ids = transport.messages.filter((message) => Object.hasOwn(message, 'id')).map((message) => message.id);
  assert.equal(ids.length, new Set(ids).size);
});

test('disconnected and uninitialized operations do not send', async () => {
  const transport = new MockStudioTransport();
  const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput });
  await rejects(bridge.discover(), 'not_ready');
  bridge.close();
  await rejects(bridge.initialize(), 'disconnected');
  await rejects(bridge.discover(), 'disconnected');
  assert.equal(transport.messages.length, 0);
});

test('wrong Studio, forged connection and model-provided studio_id fail before action dispatch', async (t) => {
  const { bridge, target, discovery, transport, prepare } = await fixture(t);
  throws(() => bridge.selectStudio('missing'), 'wrong_studio');
  const capability = discovery.capabilities[0];
  for (const modified of [{ ...target, studioId: 'studio-a' }, { ...target, connectionId: 'another' }]) {
    throws(() => bridge.prepareAction({ actionId: 'wrong', target: modified, tool: capability.name, version: capability.version, input: {} }), 'wrong_studio');
  }
  throws(() => prepare('override', 'get_studio_state', { studio_id: 'studio-a' }), 'invalid_input');
  assert.equal(actionCalls(transport).length, 0);
});

test('session disappears or changes place under the same ID: no dispatch', async (t) => {
  for (const change of ['remove', 'place']) {
    const { bridge, transport, prepare } = await fixture(t);
    const action = prepare(change);
    if (change === 'remove') transport.sessions = transport.sessions.slice(0, 1);
    else transport.sessions[1].place_id = '999';
    await rejects(bridge.execute(action.actionId), 'wrong_studio', 'not_dispatched');
    assert.equal(actionCalls(transport).length, 0);
  }
});

test('changing selection invalidates prepared actions including reviewed writes', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('write', 'multi_edit');
  bridge.reviewAction(action.actionId, action.digest, true);
  bridge.selectStudio('studio-a');
  await rejects(bridge.execute(action.actionId), 'wrong_studio');
  assert.equal(actionCalls(transport).length, 0);
});

test('default write boundary denies unreviewed writes without sending any request', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('write', 'multi_edit');
  const count = transport.messages.length;
  await rejects(bridge.execute(action.actionId), 'confirmation_required');
  assert.equal(transport.messages.length, count);
  bridge.reviewAction(action.actionId, action.digest, false);
  await rejects(bridge.execute(action.actionId), 'write_denied');
  throws(() => bridge.reviewAction(action.actionId, action.digest, true), 'review_mismatch');
});

test('exact review digest and immutable stored input; one approved mock write', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const input = edits();
  const action = prepare('write', 'multi_edit', input);
  throws(() => bridge.reviewAction(action.actionId, '0'.repeat(64), true), 'review_mismatch');
  input.edits[0].newText = 'changed after prepare';
  action.input.edits[0].newText = 'changed after review';
  action.target.studioId = 'studio-a';
  bridge.reviewAction(action.actionId, action.digest, true);
  await bridge.execute(action.actionId);
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.writes[0].studio_id, 'studio-b');
  assert.equal(transport.writes[0].edits[0].newText, 'new');
  await rejects(bridge.execute(action.actionId), 'replay');
});

test('duplicate action IDs and concurrent/repeated execution are rejected', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('one');
  throws(() => prepare('one'), 'duplicate_action');
  const running = bridge.execute(action.actionId);
  await rejects(bridge.execute(action.actionId), 'replay');
  await running;
  await rejects(bridge.execute(action.actionId), 'replay');
  assert.equal(actionCalls(transport).length, 1);
});

test('schema/description changes invalidate approval before action dispatch', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('write', 'multi_edit');
  bridge.reviewAction(action.actionId, action.digest, true);
  transport.tools.find((tool) => tool.name === 'multi_edit').description = 'changed';
  await rejects(bridge.execute(action.actionId), 'capability_changed');
  assert.equal(actionCalls(transport).length, 0);
});

test('wrong, duplicate and replayed response IDs cannot settle another action', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const first = prepare('first');
  await bridge.execute(first.actionId);
  const oldId = actionCalls(transport)[0].id;
  const second = prepare('second');
  transport.hold.add('get_studio_state');
  let settled = false;
  const pending = bridge.execute(second.actionId).then((result) => { settled = true; return result; });
  await tick();
  const request = actionCalls(transport).at(-1);
  transport.emit({ jsonrpc: '2.0', id: oldId, result: { replay: true } });
  transport.emit({ jsonrpc: '2.0', id: 'wrong-id', result: { wrong: true } });
  await tick();
  assert.equal(settled, false);
  const response = { jsonrpc: '2.0', id: request.id, result: { structuredContent: { correct: true } } };
  transport.emit(response);
  transport.emit(response);
  assert.deepEqual(await pending, response.result);
});

test('read timeout cancels the correlated request and ignores a late response', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('timeout');
  transport.hold.add('get_studio_state');
  await rejects(bridge.execute(action.actionId, { timeoutMs: 30 }), 'timeout', 'failed');
  const request = actionCalls(transport)[0];
  assert.ok(transport.cancelled.includes(request.id));
  transport.emit({ jsonrpc: '2.0', id: request.id, result: { late: true } });
  assert.equal(bridge.actionStatus(action.actionId), 'failed');
  await rejects(bridge.execute(action.actionId), 'replay');
});

test('pre-aborted request and cancellation during discovery never dispatch an action', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const pre = prepare('pre');
  await rejects(bridge.execute(pre.actionId, { signal: AbortSignal.abort() }), 'cancelled', 'not_dispatched');
  const action = prepare('during');
  const controller = new AbortController();
  transport.hold.add('tools/list');
  const running = bridge.execute(action.actionId, { signal: controller.signal });
  controller.abort();
  await rejects(running, 'cancelled', 'not_dispatched');
  assert.equal(actionCalls(transport).length, 0);
  assert.equal(transport.cancelled.length, 1);
});

test('write timeout and cancellation after dispatch require reconciliation', async (t) => {
  for (const reason of ['timeout', 'cancelled']) {
    const { bridge, transport, prepare } = await fixture(t);
    const action = prepare(reason, 'multi_edit');
    bridge.reviewAction(action.actionId, action.digest, true);
    transport.hold.add('multi_edit');
    const controller = new AbortController();
    const running = bridge.execute(action.actionId, { timeoutMs: 40, signal: controller.signal });
    if (reason === 'cancelled') { await tick(); controller.abort(); }
    await rejects(running, reason, 'unknown');
    assert.equal(bridge.actionStatus(action.actionId), 'uncertain');
    assert.equal(actionCalls(transport).length, 1);
    await rejects(bridge.execute(action.actionId), 'replay');
  }
});

test('disconnect resolves all pending waiters; dispatched write outcome stays unknown', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  transport.hold.add('get_studio_state');
  transport.hold.add('multi_edit');
  const read = prepare('read');
  const write = prepare('write', 'multi_edit');
  bridge.reviewAction(write.actionId, write.digest, true);
  const readCheck = rejects(bridge.execute(read.actionId), 'disconnected', 'failed');
  const writeCheck = rejects(bridge.execute(write.actionId), 'disconnected', 'unknown');
  await tick();
  transport.close();
  await Promise.all([readCheck, writeCheck]);
});

test('initialization timeout closes without an invalid initialize cancellation', async (t) => {
  const transport = new MockStudioTransport();
  transport.hold.add('initialize');
  const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput, timeoutMs: 20 });
  t.after(() => bridge.close());
  await rejects(bridge.initialize(), 'timeout');
  assert.equal(transport.closed, true);
  assert.equal(transport.cancelled.length, 0);
});

test('protocol and missing tools capability negotiation fail closed', async () => {
  for (const mode of ['protocol', 'capability']) {
    const transport = new MockStudioTransport();
    if (mode === 'protocol') transport.protocolVersion = 'unsupported';
    else transport.serverCapabilities = {};
    const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput });
    await rejects(bridge.initialize(), mode === 'protocol' ? 'unsupported_protocol' : 'capabilities_unavailable');
    assert.equal(transport.closed, true);
  }
});

test('discovery rejects duplicate sessions/tools, cursor loops and absent discovery tool', async (t) => {
  for (const mode of ['sessions', 'tools', 'cursor', 'missing']) {
    const { bridge, transport } = await fixture(t);
    if (mode === 'sessions') transport.sessions.push(transport.sessions[0]);
    if (mode === 'tools') transport.tools.push(transport.tools[0]);
    if (mode === 'cursor') transport.nextCursor = 'repeat';
    if (mode === 'missing') transport.tools = transport.tools.slice(1);
    await rejects(bridge.discover(), mode === 'missing' ? 'capabilities_unavailable' : 'discovery_failed');
  }
});

test('invalid schema/input, unsupported confirmation fields and oversized JSON fail closed', async (t) => {
  const { prepare, bridge, transport } = await fixture(t);
  throws(() => prepare('bad-edit', 'multi_edit', { ...edits(), confirmation: true }), 'invalid_input');
  throws(() => prepare('huge', 'multi_edit', { ...edits(), extra: 'x'.repeat(70_000) }), 'limit_exceeded');
  throws(() => prepare('function', 'get_studio_state', { callback() {} }), 'invalid_input');
  transport.tools.find((tool) => tool.name === 'get_studio_state').inputSchema = { type: 'object', properties: {} };
  await rejects(bridge.discover(), 'discovery_failed');
});

test('malformed responses and tool errors are sanitized', async (t) => {
  for (const mode of ['malformed', 'rpc-error', 'tool-error']) {
    const { bridge, transport, prepare } = await fixture(t);
    const action = prepare(mode);
    transport.replyOverride = (request) => {
      if (request.method !== 'tools/call' || request.params.name !== 'get_studio_state') return;
      if (mode === 'malformed') return { jsonrpc: '2.0', id: request.id, result: {}, error: { code: -32000, message: 'PRIVATE BODY' } };
      if (mode === 'rpc-error') return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'PRIVATE BODY' } };
      return { jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'PRIVATE BODY' }] } };
    };
    await assert.rejects(bridge.execute(action.actionId), (error) => error.code === (mode === 'malformed' ? 'protocol_error' : 'remote_error') && !error.message.includes('PRIVATE BODY'));
  }
});

test('request deadline covers discovery and dispatch, with a fixed maximum', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('discovery-timeout');
  transport.hold.add('list_roblox_studios');
  await rejects(bridge.execute(action.actionId, { timeoutMs: 25 }), 'timeout', 'not_dispatched');
  assert.equal(actionCalls(transport).length, 0);
  for (const value of [0, -1, 30_001, Infinity]) await rejects(bridge.discover({ timeoutMs: value }), 'invalid_input');
});

test('closed connection identity and approvals cannot be reused on another bridge', async (t) => {
  const first = await fixture(t);
  const proposal = first.prepare('old', 'multi_edit');
  first.bridge.reviewAction(proposal.actionId, proposal.digest, true);
  first.bridge.close();
  const second = await fixture(t);
  assert.notEqual(second.bridge.connectionId, first.bridge.connectionId);
  throws(() => second.bridge.prepareAction({ ...proposal, target: proposal.target }), 'wrong_studio');
  throws(() => second.bridge.reviewAction(proposal.actionId, proposal.digest, true), 'review_mismatch');
});

test('tools list changed invalidates proposals until discovery; action table is bounded', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  transport.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  throws(() => prepare('stale'), 'unknown_tool');
  await bridge.discover();
  for (let i = 0; i < 256; i++) prepare(`bounded-${i}`);
  throws(() => prepare('overflow'), 'limit_exceeded');
});

test('concurrent requests are bounded and close releases every waiting operation', async (t) => {
  const { bridge, transport } = await fixture(t);
  transport.hold.add('tools/list');
  const waiting = Array.from({ length: 16 }, () => rejects(bridge.discover(), 'disconnected'));
  await rejects(bridge.discover(), 'limit_exceeded');
  bridge.close();
  await Promise.all(waiting);
});

test('tool error on a dispatched write is uncertain and cannot be replayed', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('write-error', 'multi_edit');
  bridge.reviewAction(action.actionId, action.digest, true);
  transport.replyOverride = (request) => request.method === 'tools/call' && request.params.name === 'multi_edit'
    ? { jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'possibly partially applied' }] } }
    : undefined;
  await rejects(bridge.execute(action.actionId), 'remote_error', 'unknown');
  assert.equal(bridge.actionStatus(action.actionId), 'uncertain');
  await rejects(bridge.execute(action.actionId), 'replay');
});

test('oversized incoming message closes the connection without leaking its body', async (t) => {
  const { bridge, transport, prepare } = await fixture(t);
  const action = prepare('oversized');
  transport.replyOverride = (request) => request.method === 'tools/call' && request.params.name === 'get_studio_state'
    ? { jsonrpc: '2.0', id: request.id, result: { secret: 'PRIVATE BODY'.repeat(20_000) } }
    : undefined;
  await rejects(bridge.execute(action.actionId), 'disconnected', 'failed');
  assert.equal(transport.closed, true);
});
