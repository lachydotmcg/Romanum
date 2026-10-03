import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioBridge } from '../src/bridge.ts';
import { MockStudioTransport, validateFixtureInput } from '../fixtures/mock-studio.ts';

async function fixture(t) {
  const transport = new MockStudioTransport();
  const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput });
  t.after(() => bridge.close());
  await bridge.initialize();
  const discovery = await bridge.discover();
  const target = bridge.selectStudio('studio-b');
  const capability = discovery.capabilities.find(item => item.name === 'multi_edit');
  const proposal = bridge.prepareAction({ actionId: 'fenced', target, tool: 'multi_edit', version: capability.version, input: { datamodel_type: 'Edit', edits: [{ path: 'Fixture', oldText: 'red', newText: 'blue' }] } });
  bridge.reviewAction('fenced', proposal.digest, true);
  return { transport, bridge };
}
test('dispatch waits for a successful durable hook; a rejected hook sends no mutation', async t => {
  const { bridge, transport } = await fixture(t);
  let invoked = 0;
  await assert.rejects(bridge.execute('fenced', { beforeDispatch: async () => { invoked++; assert.equal(transport.writes.length, 0); throw new Error('storage refused'); } }), error => error.outcome === 'not_dispatched');
  assert.equal(invoked, 1);
  assert.equal(bridge.actionStatus('fenced'), 'failed');
  assert.equal(transport.toolCalls.filter(call => call.params.name === 'multi_edit').length, 0);
});
test('cancellation during a durable hook is rechecked before send', async t => {
  const { bridge, transport } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(bridge.execute('fenced', { signal: controller.signal, beforeDispatch: async () => { controller.abort(); } }), error => error.code === 'cancelled' && error.outcome === 'not_dispatched');
  assert.equal(transport.writes.length, 0);
});
test('a target changed during an asynchronous durable hook cannot receive the approved write', async t => {
  const { bridge, transport } = await fixture(t);
  await assert.rejects(bridge.execute('fenced', { beforeDispatch: async () => { bridge.selectStudio('studio-a'); } }), error => error.code === 'wrong_studio' && error.outcome === 'not_dispatched');
  assert.equal(transport.writes.length, 0);
});
