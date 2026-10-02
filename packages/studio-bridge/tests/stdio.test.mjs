import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StudioBridge } from '../src/index.ts';
import { createFixtureStdioTransport, createOwnerStdioTransport, createSdkInputValidator, loadInstalledMcpSdk } from '../src/transport/index.ts';

// Optional test-only anchor reuses the existing checked-out lockfile toolchain.
// It is never forwarded to a fixture process or supplied by a model.
const sdk = loadInstalledMcpSdk(process.env.ROMANUM_BRIDGE_SDK_ROOT ? path.join(process.env.ROMANUM_BRIDGE_SDK_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const rejects = (promise, code, outcome) => assert.rejects(promise, (error) => error.code === code && (outcome === undefined || error.outcome === outcome));
const throws = (run, code) => assert.throws(run, (error) => error.code === code);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, mode = 'normal', initialize = true) {
  const transport = createFixtureStdioTransport(sdk, mode);
  const bridge = new StudioBridge(transport, { validateInput: transport.validateInput, timeoutMs: 15_000 });
  t.after(async () => { bridge.close(); await transport.waitForClose(); });
  await transport.start();
  if (initialize) await bridge.initialize();
  return { transport, bridge };
}
async function prepare(bridge, actionId, tool = 'get_studio_state') {
  const discovery = await bridge.discover();
  const target = bridge.selectStudio('studio-b');
  const capability = discovery.capabilities.find((item) => item.name === tool);
  return bridge.prepareAction({ actionId, target, tool, version: capability.version, input: tool === 'multi_edit' ? { datamodel_type: 'Edit', edits: [{ path: 'game.Mock', oldText: 'old', newText: 'new' }] } : {} });
}

test('authored stdio process negotiates, discovers and reads selected mock Studio', async (t) => {
  const { bridge, transport } = await fixture(t);
  const action = await prepare(bridge, 'read');
  const result = await bridge.execute(action.actionId);
  assert.equal(result.structuredContent.studio_id, 'studio-b');
  assert.equal(result.structuredContent.mock, true);
  assert.ok(transport.pid);
  bridge.close();
  await transport.waitForClose();
  assert.equal(transport.failureCode, undefined);
});

test('owner path is disabled by default and cannot accept shell/script executables', () => {
  for (const config of [{}, { executable: process.execPath }, { enabled: false, executable: process.execPath }]) throws(() => createOwnerStdioTransport(config, sdk), 'transport_disabled');
  for (const executable of [process.execPath, 'StudioMCP.exe', 'cmd.exe', path.resolve('server.bat')]) throws(() => createOwnerStdioTransport({ enabled: true, executable }, sdk), 'invalid_config');
  throws(() => createFixtureStdioTransport(sdk, 'custom-command'), 'invalid_config');
});

test('malformed JSON/RPC closes and reaps the child; read failure is bounded', async (t) => {
  for (const mode of ['malformed-json', 'malformed-rpc']) {
    const { bridge, transport } = await fixture(t, mode);
    const action = await prepare(bridge, mode);
    await rejects(bridge.execute(action.actionId), 'disconnected', 'failed');
    assert.equal(transport.failureCode, 'invalid_message');
    await transport.waitForClose();
  }
});

test('invalid and unsupported remote schemas fail before any action dispatch', async (t) => {
  for (const mode of ['invalid-schema', 'unsupported-schema']) {
    const { bridge, transport } = await fixture(t, mode);
    await rejects(bridge.discover(), 'disconnected');
    assert.equal(transport.failureCode, 'invalid_schema');
    assert.equal(transport.writesSent, 0);
  }
});

test('SDK validator enforces types and unknown constraints without mutating input', () => {
  const validator = createSdkInputValidator(sdk);
  const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false };
  const input = { count: '1' };
  assert.equal(validator.validateInput(schema, input), false);
  assert.equal(input.count, '1');
  assert.equal(validator.validateInput(schema, { count: 1 }), true);
  assert.equal(validator.validateInput({ ...schema, inventedKeyword: true }, { count: 1 }), false);
  assert.equal(validator.validateInput({ ...schema, $schema: 'https://invalid.example/schema' }, { count: 1 }), false);
  assert.equal(validator.validateInput({ type: 'object', $ref: 'https://invalid.example/schema' }, {}), false);
});

test('unexpected and duplicated response IDs are ignored across actual stdio', async (t) => {
  const { bridge, transport } = await fixture(t, 'unexpected-ids');
  const action = await prepare(bridge, 'ids');
  assert.equal((await bridge.execute(action.actionId)).structuredContent.correct, true);
  await tick();
  assert.equal(transport.ignoredResponses, 2);
  await rejects(bridge.execute(action.actionId), 'replay');
});

test('process crash settles read and write with the correct uncertainty boundary', async (t) => {
  for (const mode of ['crash-read', 'crash-write']) {
    const { bridge, transport } = await fixture(t, mode);
    const write = mode === 'crash-write';
    const action = await prepare(bridge, mode, write ? 'multi_edit' : 'get_studio_state');
    if (write) bridge.reviewAction(action.actionId, action.digest, true);
    await rejects(bridge.execute(action.actionId), 'disconnected', write ? 'unknown' : 'failed');
    assert.equal(transport.failureCode, 'child_exit');
    assert.equal(bridge.actionStatus(action.actionId), write ? 'uncertain' : 'failed');
    await transport.waitForClose();
  }
});

test('read timeout/cancellation sends correlated cancellation and ignores late replies', async (t) => {
  for (const reason of ['timeout', 'cancelled']) {
    const { bridge, transport } = await fixture(t, 'timeout-read');
    const action = await prepare(bridge, reason);
    const controller = new AbortController();
    const check = rejects(bridge.execute(action.actionId, { timeoutMs: reason === 'timeout' ? 1_000 : 5_000, signal: controller.signal }), reason, 'failed');
    if (reason === 'cancelled') {
      const deadline = Date.now() + 4_000;
      while (transport.readsSent === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(transport.readsSent, 1);
      controller.abort();
    }
    await check;
    const next = await prepare(bridge, `after-${reason}`);
    const state = await bridge.execute(next.actionId);
    assert.equal(state.structuredContent.cancelled.length, 1);
    assert.equal(bridge.actionStatus(action.actionId), 'failed');
    assert.equal(transport.ignoredResponses, 1);
  }
});

test('a timed-out applied mock write stays uncertain and cannot be duplicated', async (t) => {
  const { bridge, transport } = await fixture(t, 'timeout-write');
  const action = await prepare(bridge, 'write', 'multi_edit');
  await rejects(bridge.execute(action.actionId), 'confirmation_required');
  assert.equal(transport.writesSent, 0);
  bridge.reviewAction(action.actionId, action.digest, true);
  await rejects(bridge.execute(action.actionId, { timeoutMs: 1_000 }), 'timeout', 'unknown');
  await rejects(bridge.execute(action.actionId), 'replay');
  const read = await prepare(bridge, 'inspect');
  const state = await bridge.execute(read.actionId);
  assert.equal(state.structuredContent.writes, 1);
  assert.equal(transport.writesSent, 1);
  assert.equal(bridge.actionStatus(action.actionId), 'uncertain');
});

test('oversized framed and unframed messages close before JSON parsing', async (t) => {
  for (const mode of ['oversized', 'oversized-unframed']) {
    const { bridge, transport } = await fixture(t, mode);
    const action = await prepare(bridge, mode);
    await rejects(bridge.execute(action.actionId), 'disconnected', 'failed');
    assert.equal(transport.failureCode, 'frame_too_large');
    await transport.waitForClose();
  }
});

test('missing tools capability and initialize timeout close the process', async (t) => {
  for (const mode of ['missing-capabilities', 'init-timeout']) {
    const { bridge, transport } = await fixture(t, mode, false);
    await rejects(bridge.initialize({ timeoutMs: mode === 'init-timeout' ? 500 : 15_000 }), mode === 'init-timeout' ? 'timeout' : 'capabilities_unavailable');
    await transport.waitForClose();
  }
});

test('EOF-resistant authored fixture is terminated and reaped using its child handle', async (t) => {
  const { bridge, transport } = await fixture(t, 'ignore-eof');
  const pid = transport.pid;
  bridge.close();
  await transport.waitForClose();
  assert.throws(() => process.kill(pid, 0));
});

test('split UTF-8 is preserved and stderr diagnostics never reach bridge results', async (t) => {
  for (const mode of ['split-utf8', 'stderr']) {
    const { bridge, transport } = await fixture(t, mode);
    const action = await prepare(bridge, mode);
    const result = await bridge.execute(action.actionId);
    assert.equal(result.structuredContent.label, 'Romanum 🏛️');
    assert.ok(!JSON.stringify(result).includes('UNTRUSTED DIAGNOSTIC'));
    assert.equal(transport.failureCode, undefined);
  }
});

test('transport rejects duplicate outbound IDs and does not restart after close', async (t) => {
  const { transport, bridge } = await fixture(t);
  transport.send({ jsonrpc: '2.0', id: 'manual-list', method: 'tools/list', params: {} });
  throws(() => transport.send({ jsonrpc: '2.0', id: 'manual-list', method: 'tools/list', params: {} }), 'invalid_message');
  bridge.close();
  await transport.waitForClose();
  await rejects(transport.start(), 'closed');
});

test('server ping is answered while unnegotiated roots access is denied', async (t) => {
  const { bridge } = await fixture(t, 'server-requests');
  const first = await prepare(bridge, 'server-requests');
  await bridge.execute(first.actionId);
  const next = await prepare(bridge, 'confirm-server-requests');
  const result = await bridge.execute(next.actionId);
  assert.equal(result.structuredContent.pingResponses, 1);
  assert.equal(result.structuredContent.deniedRequests, 1);
});

test('cancellation after write enqueue does not duplicate an applied mock write', async (t) => {
  const { bridge, transport } = await fixture(t, 'timeout-write');
  const action = await prepare(bridge, 'cancel-write', 'multi_edit');
  bridge.reviewAction(action.actionId, action.digest, true);
  const controller = new AbortController();
  const check = rejects(bridge.execute(action.actionId, { signal: controller.signal, timeoutMs: 5_000 }), 'cancelled', 'unknown');
  const deadline = Date.now() + 4_000;
  while (transport.writesSent === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(transport.writesSent, 1);
  controller.abort();
  await check;
  await rejects(bridge.execute(action.actionId), 'replay');
  const read = await prepare(bridge, 'read-cancelled-write');
  assert.equal((await bridge.execute(read.actionId)).structuredContent.writes, 1);
});

test('transport bounds pending outbound requests before accepting more work', async (t) => {
  const { transport, bridge } = await fixture(t);
  for (let i = 0; i < 16; i++) transport.send({ jsonrpc: '2.0', id: `bounded-${i}`, method: 'tools/list', params: {} });
  throws(() => transport.send({ jsonrpc: '2.0', id: 'overflow', method: 'tools/list', params: {} }), 'invalid_message');
  bridge.close();
  await transport.waitForClose();
});

test('a failing close subscriber cannot leave the authored child running', async (t) => {
  const { bridge, transport } = await fixture(t);
  const pid = transport.pid;
  transport.onClose(() => { throw new Error('subscriber failure'); });
  bridge.close();
  await transport.waitForClose();
  assert.throws(() => process.kill(pid, 0));
});

test('optional output schemas are validated and removed schemas do not remain cached', async (t) => {
  const invalid = await fixture(t, 'invalid-output');
  const action = await prepare(invalid.bridge, 'invalid-output');
  await rejects(invalid.bridge.execute(action.actionId), 'disconnected', 'failed');
  assert.equal(invalid.transport.failureCode, 'invalid_schema');
  const removed = await fixture(t, 'removed-output');
  await removed.bridge.discover();
  const current = await prepare(removed.bridge, 'removed-output');
  assert.equal((await removed.bridge.execute(current.actionId)).structuredContent.studio_id, 'studio-b');
});
