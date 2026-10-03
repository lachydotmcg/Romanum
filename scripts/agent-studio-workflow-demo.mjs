import assert from 'node:assert/strict';
import { workflowFixture, reviewedWorkflow } from './fixtures/agent-studio-workflow.mjs';

const fixture = await workflowFixture();
try {
  const { inspected, proposed, review, actionId } = await reviewedWorkflow(fixture);
  assert.equal(inspected.body.result.status, 'succeeded');
  assert.equal(proposed.body.result.status, 'proposed');
  assert.equal(review.body.result.status, 'approved');
  const executed = await fixture.send('execute', { actionId });
  const replay = await fixture.send('execute', { actionId });
  assert.equal(executed.body.result.status, 'succeeded');
  assert.equal(replay.body.result.actionId, actionId);
  assert.equal(fixture.transport.writes.length, 1);
  assert.equal(fixture.instance.source, "return 'blue'");
  console.log(JSON.stringify({ fixtureOnly: true, selectedStudio: 'studio-b', inspection: inspected.body.result.status, review: review.body.result.status, execution: executed.body.result.status, writeDispatchesAfterReplay: fixture.transport.writes.length, liveStudioAccessed: false }));
} finally { await fixture.close(); }
