import { createInterface } from 'node:readline';
import { MockStudioTransport } from './mock-studio.ts';

// Authored test process: stdin/stdout only; no listeners, game access or file writes.
const mode = process.argv[3];
if (process.argv[2] !== '--mode' || !mode) process.exit(64);
const peer = new MockStudioTransport();
peer.tools.find((tool) => tool.name === 'multi_edit').inputSchema.properties.edits.items = {
  type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
  required: ['path', 'oldText', 'newText'], additionalProperties: false,
};
const received = new Map();
let triggered = false;
let pingResponses = 0;
let deniedRequests = 0;
let toolLists = 0;
const respond = (message) => process.stdout.write(JSON.stringify(message) + '\n');
peer.onMessage((message) => {
  if (mode === 'missing-capabilities' && received.get(message.id)?.method === 'initialize') message.result.capabilities = {};
  respond(message);
});
peer.replyOverride = (request) => {
  if (request.method === 'tools/list') {
    toolLists++;
    if (mode === 'invalid-output' || mode === 'removed-output') {
      const tools = structuredClone(peer.tools);
      if (mode === 'invalid-output' || toolLists === 1) tools.find((tool) => tool.name === 'get_studio_state').outputSchema = {
        type: 'object', properties: { studio_id: { type: 'integer' } }, required: ['studio_id'], additionalProperties: true,
      };
      return { jsonrpc: '2.0', id: request.id, result: { tools } };
    }
  }
  if (request.method === 'tools/list' && (mode === 'invalid-schema' || mode === 'unsupported-schema')) {
    const tools = structuredClone(peer.tools);
    const schema = tools.find((tool) => tool.name === 'get_studio_state').inputSchema;
    if (mode === 'invalid-schema') schema.properties.studio_id.type = 'not-a-type';
    else schema.properties.studio_id.pattern = '(a+)+$';
    return { jsonrpc: '2.0', id: request.id, result: { tools } };
  }
  if (request.method !== 'tools/call' || request.params.name !== 'get_studio_state') return;
  return { jsonrpc: '2.0', id: request.id, result: {
    content: [], structuredContent: { mock: true, studio_id: request.params.arguments.studio_id, writes: peer.writes.length, cancelled: peer.cancelled, label: 'Romanum 🏛️', pingResponses, deniedRequests },
  } };
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(65); }
  if (message.method === undefined) {
    if (message.id === 'server-ping' && message.result && Object.keys(message.result).length === 0) pingResponses++;
    if (message.id === 'server-roots' && message.error?.code === -32601) deniedRequests++;
    return;
  }
  if (message.id) received.set(message.id, message);
  if (mode === 'init-timeout' && message.method === 'initialize') return;
  if (mode === 'stderr' && message.method === 'initialize') process.stderr.write('UNTRUSTED DIAGNOSTIC\n'.repeat(30_000));
  if (message.method === 'notifications/cancelled') {
    peer.send(message);
    // An intentionally late response tests that cancellation cannot revive work.
    respond({ jsonrpc: '2.0', id: message.params.requestId, result: { content: [], structuredContent: { late: true } } });
    return;
  }
  const tool = message.method === 'tools/call' ? message.params.name : undefined;
  if (!triggered && tool === 'get_studio_state') {
    triggered = true;
    if (mode === 'malformed-json') { process.stdout.write('{malformed-json\n'); return; }
    if (mode === 'malformed-rpc') { respond({ jsonrpc: 'wrong', id: message.id, result: {} }); return; }
    if (mode === 'crash-read') process.exit(71);
    if (mode === 'timeout-read') return;
    if (mode === 'oversized') { respond({ jsonrpc: '2.0', id: message.id, result: { body: 'x'.repeat(140_000) } }); return; }
    if (mode === 'oversized-unframed') { process.stdout.write('x'.repeat(140_000)); return; }
    if (mode === 'unexpected-ids') {
      const result = { content: [], structuredContent: { correct: true } };
      respond({ jsonrpc: '2.0', id: 'unrelated-request', result });
      respond({ jsonrpc: '2.0', id: message.id, result });
      respond({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (mode === 'split-utf8') {
      const wire = Buffer.from(JSON.stringify(peer.replyOverride(message)) + '\n');
      const split = wire.indexOf(Buffer.from('🏛')) + 1;
      process.stdout.write(wire.subarray(0, split));
      setTimeout(() => process.stdout.write(wire.subarray(split)), 5);
      return;
    }
    if (mode === 'server-requests') {
      respond({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' });
      respond({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list' });
    }
  }
  if (tool === 'multi_edit' && (mode === 'timeout-write' || mode === 'crash-write')) {
    peer.writes.push(structuredClone(message.params.arguments));
    if (mode === 'crash-write') process.exit(72);
    return;
  }
  peer.send(message);
});
if (mode === 'ignore-eof') {
  setInterval(() => undefined, 60_000);
  lines.on('close', () => undefined);
} else lines.on('close', () => process.exit(0));
