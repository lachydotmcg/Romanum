# Local agent-job API foundation

This is a model-independent, trusted local/server facade over the existing
`src/lib/harness/runner.ts`. It does not add an HTTP endpoint, background worker,
Studio bridge or another coordinator. It defaults to disabled and accepts only
`HarnessModel.mode === "test"`. Free public analytics and MCP are unaffected.
No provider keys, billing configuration or new migrations are required.

The application supplies its already established owner identity, `Database`,
`HarnessModel` and trusted `HarnessTool[]`. Requests cannot supply an owner,
credentials, tool definitions, approval or automatic-write delegation. A caller
must explicitly opt in with `enabled: true`; this is a local development gate,
not an authentication mechanism or authorization to expose a network service.

```ts
import { createLocalAgentApi } from "./index.ts";

const api = createLocalAgentApi({
  enabled: true, database, ownerId, model: testModel, tools: trustedTools,
});
const job = await api.create({
  version: 1, projectId, objective: "Summarize the stored project tasks.",
  allowedTools: ["read_project"], maxSteps: 3,
});
const controller = new AbortController();
const { job: checkpoint, events } = await api.run(job.jobId, {
  signal: controller.signal,
});
// During execution: controller.abort() or await api.cancel(job.jobId).
// Later: await api.read(job.jobId), or run again after a trusted worker event.
```

`create` persists a ready run without invoking a model. Requests are strict,
versioned and bounded to 1–20 model decisions (default 12), including the final
answer; allowed tool names must be unique and registered. `run` uses the existing
40-unit checkpoint loop and durable claims. Reads and cancellation remain owner
scoped. Results project status, steps, final text, waiting job ID and action
summaries; they omit context, identity, claims, approval digests and tool payloads.
Final text is the owner's model output, not a guarantee of factual correctness.

Read actions can execute. Writes and Studio execution pause at
`awaiting_approval`; this facade never grants approval or delegates writes. Exact
action review stays in the existing trusted `reviewAgentAction` interface, which
is not a model tool. Runs created elsewhere with automatic-write delegation are
rejected. Cancelling a running mutation preserves `uncertain` and
`reconciliation_required`; it never retries an ambiguous action. Cancelling
reasoning does not cancel independently queued creative jobs.

`events` is a transient trace returned by one `run` invocation, ordered by a
sequence starting at 1 with a distinct execution ID. It is not a replayable log or
live subscription. `model.returned` and `tool.returned` only mean the adapter
returned; validation and durable outcomes appear in `job.checkpoint` and the
result. Events contain no prompts, raw payloads or raw exceptions. An adapter
ignoring abort may finish later; its late events/results cannot revive the job.
Concurrent calls rely on the runner's existing claims and can return `running`;
event ordering is per invocation, not a total order across workers. Retrying
`create` creates another job; no submission idempotency is claimed.

Run the fixture demonstration from the repository root:

```sh
node scripts/agent-api-demo.mjs
node --test tests/agent-api.test.mjs tests/harness.test.mjs tests/harness-wait.test.mjs
```

The demo uses an ephemeral PGlite database, existing migrations, a stored fixture
project, a read tool and a finite scripted mock model. Its answer is derived from
the tool's actual fixture observation. It prints `completed`, two model steps,
one succeeded action and eight ordered events. It never uses a production
connection or provider. `mock.ts` adapters are development fixtures, not AI.

Authenticated transport, production provider budgets, persistent event delivery,
worker dispatch and hosted Studio integration remain separate future work.
