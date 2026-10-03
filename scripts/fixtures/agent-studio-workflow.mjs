import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrateHistory } from '../../src/lib/history/migrate.ts';
import { createCreativeProject } from '../../src/lib/creative/storage.ts';
import { createFixtureStudioWorkflow } from '../../src/lib/agent-api-studio-workflow/service.ts';
import { studioWorkflowResponse } from '../../src/lib/agent-api-studio-workflow/http.ts';
import { MockStudioTransport } from '../../packages/studio-bridge/fixtures/mock-studio.ts';

export const fixtureEdit = { datamodel_type: 'Edit', edits: [{ path: 'ServerScriptService.Fixture', oldText: 'red', newText: 'blue' }] };
export async function workflowDatabase(directory) {
  const engine = await PGlite.create(directory);
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  return { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
}
export async function workflowFixture({ directory, existingProjectId } = {}) {
  const database = await workflowDatabase(directory);
  if (!existingProjectId) {
    await migrateHistory(database);
    await database.exec(await readFile(new URL('../../src/lib/agent-api-studio-workflow/schema.sql', import.meta.url), 'utf8'));
  }
  const ownerId = 'fixture-signed-in-owner';
  const project = existingProjectId ? { id: existingProjectId } : await createCreativeProject(database, { ownerId, name: 'Authored workflow fixture', context: { game: 'Authored workflow fixture' } });
  const transport = new MockStudioTransport();
  const instance = { source: "return 'red'" };
  transport.replyOverride = request => {
    if (request.method !== 'tools/call') return;
    if (request.params.name === 'get_studio_state') return { jsonrpc: '2.0', id: request.id, result: { structuredContent: { studio_id: request.params.arguments.studio_id, source: instance.source, mock: true }, content: [] } };
    if (request.params.name !== 'multi_edit') return;
    const edit = request.params.arguments.edits[0];
    if (request.params.arguments.studio_id !== 'studio-b' || !instance.source.includes(edit.oldText)) return { jsonrpc: '2.0', id: request.id, result: { isError: true, content: [] } };
    transport.writes.push(structuredClone(request.params.arguments));
    instance.source = instance.source.replace(edit.oldText, edit.newText);
    return { jsonrpc: '2.0', id: request.id, result: { structuredContent: { source: instance.source, applied: true, mock: true }, content: [] } };
  };
  const workflow = await createFixtureStudioWorkflow({ enabled: true, database, ownerId, transport });
  let account = { ownerId };
  const deps = { enabled: true, account: async () => account, isCrossSite: () => false, workflow: async resolved => resolved === ownerId ? workflow : null };
  const send = async (operation, fields = {}, key = operation, customDeps = deps) => {
    const request = new Request('https://romanum.test/api/agent-studio-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, operation, key, ...fields }) });
    const response = await studioWorkflowResponse(request, customDeps);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { database, ownerId, project, transport, instance, workflow, deps, send, setAccount: value => { account = value; }, close: async () => { workflow.close(); await database.close(); } };
}
export async function reviewedWorkflow(fixture) {
  const selected = await fixture.send('select', { studioId: 'studio-b' });
  const inspected = await fixture.send('inspect', { selectionId: selected.body.result.selectionId });
  const proposed = await fixture.send('propose', { inspectionId: inspected.body.result.actionId, input: fixtureEdit });
  const review = await fixture.send('review', { actionId: proposed.body.result.actionId, digest: proposed.body.result.digest, approve: true });
  return { selected, inspected, proposed, review, actionId: proposed.body.result.actionId };
}
