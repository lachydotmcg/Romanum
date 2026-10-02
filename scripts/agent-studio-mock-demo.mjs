import { studioJobFixture, proposedWrite, approveRunner } from './fixtures/agent-studio-mock.mjs';

const fixture = await studioJobFixture();
try {
  const { created, checkpoint, review } = await proposedWrite(fixture);
  await approveRunner(fixture, review);
  let runnerOnlyBlocked = false;
  try { await fixture.adapter.run(created.jobId); }
  catch (error) { if (error.code !== 'review_required') throw error; runnerOnlyBlocked = true; }
  if (!runnerOnlyBlocked || fixture.transport.writes.length !== 0) throw new Error('Separate bridge review gate failed.');
  await fixture.adapter.reviewBridge(created.jobId, review.bridge.actionId, review.bridge.digest, true);
  const completed = await fixture.adapter.run(created.jobId);
  console.log(JSON.stringify({
    mode: 'mock_only', studio: fixture.adapter.target.studioId,
    capabilities: fixture.adapter.discovery.capabilities.map(({ name, effect }) => ({ name, effect })),
    initialStatus: checkpoint.job.status, runnerOnlyBlocked,
    distinctApprovalDigests: review.runnerDigest !== review.bridge.digest,
    finalStatus: completed.job.status, steps: completed.job.steps,
    mockWrites: fixture.transport.writes.length, mockInstance: fixture.instance,
    output: completed.job.output,
  }, null, 2));
  if (completed.job.status !== 'completed') process.exitCode = 1;
} finally {
  fixture.adapter.close();
  await fixture.database.close();
}
