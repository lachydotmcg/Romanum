import { createLocalAgentApi } from '../src/lib/agent-api/index.ts';
import { agentFixture } from './fixtures/agent-api.mjs';

const fixture = await agentFixture();
try {
  const api = createLocalAgentApi({
    enabled: true, database: fixture.database, ownerId: fixture.ownerId,
    model: fixture.model, tools: [fixture.tool],
  });
  const created = await api.create({
    version: 1, projectId: fixture.project.id,
    objective: 'Summarize the stored fixture task list.',
    allowedTools: ['read_project'], maxSteps: 3,
  });
  const execution = await api.run(created.jobId);
  console.log(JSON.stringify({
    mode: 'local_test_fixture', status: execution.job.status,
    steps: execution.job.steps, output: execution.job.output,
    actions: execution.job.actions.map(({ tool, status }) => ({ tool, status })),
    events: execution.events.map(({ sequence, type }) => ({ sequence, type })),
  }, null, 2));
  if (execution.job.status !== 'completed') process.exitCode = 1;
} finally {
  await fixture.database.close();
}
