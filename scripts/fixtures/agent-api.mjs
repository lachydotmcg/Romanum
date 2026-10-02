import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { migrateHistory } from '../../src/lib/history/migrate.ts';
import { createCreativeProject, requireProject } from '../../src/lib/creative/storage.ts';
import { createMockTool, createScriptedModel } from '../../src/lib/agent-api/mock.ts';

// Development fixture only. Never reads connection files, credentials or env.
export async function agentFixture() {
  const engine = new PGlite();
  const adapter = sql => ({ query: (text, values) => sql.query(text, values), exec: text => sql.exec(text) });
  const database = { ...adapter(engine), transaction: fn => engine.transaction(sql => fn(adapter(sql))), close: () => engine.close() };
  try {
    await migrateHistory(database);
    const ownerId = 'agent-api-fixture-owner';
    const project = await createCreativeProject(database, {
      ownerId, name: 'Agent API fixture',
      context: { game: 'Local fixture', todos: [
        { id: 'first-session', text: 'Review first-session instructions', done: false },
        { id: 'art', text: 'Review supplied artwork', done: true },
      ] },
    });
    const tool = createMockTool({
      name: 'read_project', schema: z.object({}).strict(),
      async execute(_input, context) {
        const stored = await requireProject(database, context.ownerId, context.projectId);
        return { source: 'local_test_fixture', todos: stored.context.todos };
      },
    });
    const model = createScriptedModel([
      { kind: 'tool', tool: 'read_project', input: {}, reason: 'Read the stored fixture task list.' },
      input => {
        const observation = input.observations.at(-1);
        if (observation?.status !== 'succeeded' || observation.result?.source !== 'local_test_fixture') throw new Error('Missing fixture observation.');
        const open = observation.result.todos.filter(todo => !todo.done);
        return { kind: 'final', text: `Local test fixture has ${open.length} open task(s): ${open.map(todo => todo.text).join('; ')}.` };
      },
    ]);
    return { database, ownerId, project, tool, model };
  } catch (error) {
    await database.close();
    throw error;
  }
}
