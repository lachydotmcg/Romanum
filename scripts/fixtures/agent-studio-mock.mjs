import { MockStudioTransport } from '../../packages/studio-bridge/fixtures/mock-studio.ts';
import { createScriptedModel } from '../../src/lib/agent-api/mock.ts';
import { createMockStudioJobAdapter } from '../../src/lib/agent-api-studio-adapter/index.ts';
import { reviewAgentAction } from '../../src/lib/harness/runner.ts';
import { agentFixture } from './agent-api.mjs';

export const readDecision = { kind: 'tool', tool: 'studio_get_studio_state', input: {}, reason: 'Read the explicitly selected mock Studio.' };
export const writeDecision = {
  kind: 'tool', tool: 'studio_multi_edit', reason: 'Propose this exact fixture edit for owner review.',
  input: { datamodel_type: 'Edit', edits: [{ path: 'ServerScriptService.MockScript', oldText: 'red', newText: 'blue' }] },
};
export class ControlledMockStudioTransport extends MockStudioTransport {
  onActionDispatch;
  send(message) {
    super.send(message);
    if (message.method === 'tools/call' && message.params.name !== 'list_roblox_studios') this.onActionDispatch?.(structuredClone(message));
  }
}
export async function studioJobFixture(options = {}) {
  const fixture = await agentFixture();
  const transport = new ControlledMockStudioTransport();
  const instance = { path: 'ServerScriptService.MockScript', className: 'Script', source: "return 'red'" };
  transport.replyOverride = request => {
    if (request.method !== 'tools/call') return;
    const { name, arguments: input } = request.params;
    if (name === 'get_studio_state' && input.studio_id === 'studio-b') return {
      jsonrpc: '2.0', id: request.id,
      result: { structuredContent: { studio_id: 'studio-b', mock: true, instance: structuredClone(instance) }, content: [] },
    };
    if (name !== 'multi_edit') return;
    const edit = input.edits[0];
    if (input.studio_id !== 'studio-b' || input.edits.length !== 1 || edit.path !== instance.path || !instance.source.includes(edit.oldText)) return {
      jsonrpc: '2.0', id: request.id, result: { isError: true, content: [] },
    };
    const before = instance.source;
    instance.source = before.replace(edit.oldText, edit.newText);
    transport.writes.push(structuredClone(input));
    return { jsonrpc: '2.0', id: request.id, result: {
      structuredContent: { mock: true, applied: true, before, after: instance.source }, content: [],
    } };
  };
  const model = options.model ?? createScriptedModel([
    readDecision,
    input => {
      const state = input.observations.at(-1)?.result?.structuredContent;
      if (state?.mock !== true || state.studio_id !== 'studio-b' || state.instance?.source !== "return 'red'") throw new Error('Missing mock instance evidence.');
      return writeDecision;
    },
    input => {
      const result = input.observations.at(-1)?.result?.structuredContent;
      if (result?.mock !== true || result.applied !== true) throw new Error('Missing actual fixture write observation.');
      return { kind: 'final', text: `Mock-only edit observed: ${result.before} -> ${result.after}. No live Studio was accessed.` };
    },
  ]);
  try {
    const adapter = await createMockStudioJobAdapter({
      enabled: true, database: fixture.database, ownerId: fixture.ownerId,
      projectId: fixture.project.id, studioId: 'studio-b', model, transport,
      approvalTtlMs: options.approvalTtlMs, now: options.now,
    });
    return { ...fixture, adapter, transport, instance };
  } catch (error) { await fixture.database.close(); throw error; }
}
export const studioRequest = projectId => ({
  version: 1, projectId, objective: 'Read and propose an edit to the selected mock script.',
  allowedTools: ['studio_get_studio_state', 'studio_multi_edit'], maxSteps: 4,
});
export async function proposedWrite(fixture) {
  const created = await fixture.adapter.api.create(studioRequest(fixture.project.id));
  const checkpoint = await fixture.adapter.run(created.jobId);
  if (checkpoint.job.status !== 'awaiting_approval') throw new Error('Expected pending write review.');
  const action = checkpoint.job.actions.find(item => item.effect === 'write');
  const review = await fixture.adapter.prepareWrite(created.jobId, action.actionId);
  return { created, checkpoint, action, review };
}
export const approveRunner = (fixture, review, approve = true) => reviewAgentAction(fixture.database, {
  ownerId: fixture.ownerId, runId: review.runId, actionId: review.bridge.actionId,
  digest: review.runnerDigest, approve,
});
