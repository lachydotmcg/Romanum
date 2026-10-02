# Mock-only agent / Studio bridge adapter

This proves the existing agent-job and bridge contracts can cooperate against
fixture memory. It does not provide live Studio access, an API endpoint, a
listener, a helper installer or production activation. Neither foundation's
source is modified. The factory defaults to disabled, accepts test models and
the supplied in-memory `MockStudioTransport` only, and uses only its known
fixture schemas. Unknown schemas fail closed rather than being projected as
assumed live Roblox schemas.

```sh
node scripts/agent-studio-mock-demo.mjs
node --test tests/agent-studio-adapter.test.mjs tests/agent-api.test.mjs packages/studio-bridge/tests/bridge.test.mjs
```

The demo explicitly chooses `studio-b`, discovers two capabilities, and reads
an actual fixture `Script` instance through `get_studio_state`. The scripted
model then proposes an exact `multi_edit`. Nothing changes before review. The
demo approves the runner action first and demonstrates that the adapter still
blocks the write. After a separate exact bridge-digest review, the mock script
changes from `return 'red'` to `return 'blue'`. The final model message uses the
returned fixture observations; it does not claim a live game was changed.

## Trusted controller flow

Supply a trusted owner, owned project, explicit Studio ID, ephemeral fixture
database, test model and mock transport to `createMockStudioJobAdapter` with
`enabled: true`. Selection and discovery happen in this trusted controller,
outside the model tool registry. `api` is the unchanged local job API.

1. Create a job through `adapter.api.create`, allowing the returned
   `studio_get_studio_state` and `studio_multi_edit` tool names.
2. Call **`adapter.run`**. It uses the existing job runner and pauses a proposed
   write at the existing `awaiting_approval` checkpoint.
3. Call `prepareWrite(runId, actionId)`. It reads the owner/project/run/action
   record, verifies allowed tool/version/effect/target and prepares a copied
   bridge proposal using that exact durable action ID. It returns the runner
   digest, bridge proposal and expiry. Preparing again cannot renew expiry.
4. Review the runner through the existing trusted `reviewAgentAction` function,
   using the runner digest. Separately call
   `reviewBridge(runId, actionId, bridgeDigest, approve)` with the bridge digest.
   The digests differ and are not interchangeable. Neither review is a model
   tool; selecting a Studio is not proof of ownership or permission to edit it.
5. Call `adapter.run` again. A runner-approved write remains undispatched when
   bridge review is missing, mismatched, denied or expired. Only both approvals
   can proceed; the bridge still refreshes target/capabilities before dispatch.

Tool execution checks the actual owner/project/run/action record and parsed
input. Model input cannot set `studio_id`; the bridge injects the selected ID.
The returned discovery and review objects are copies. Review records are
process-local, bounded by the bridge's action limit. Expiry defaults to five
seconds and is configurable from 1–30,000 ms for fixtures. It is checked on
review, guarded run and execution, and the bridge's absolute operation deadline
is capped by the remaining approval window. A trusted `now` callback exists
only to make expiry fixtures deterministic.

## Cancellation and precise outcomes

Use an `AbortSignal` with `adapter.run` or `adapter.api.cancel`. Pre-abort
cancels the job before dispatch. The bridge distinguishes `not_dispatched`
from a dispatched write's `unknown` outcome; `evidence(runId, actionId)` exposes
its safe status/error/outcome under the same owner/project binding. No raw
upstream body is returned. Neither module retries uncertain actions, and late
responses cannot revive a terminal action. Cancellation does not promise rollback.

The unchanged runner marks a write as running before invoking its tool. It
therefore conservatively records `uncertain` even if the bridge later proves
`not_dispatched`, such as cancellation during refresh or a changed Studio.
The adapter preserves that runner status and retains the more precise bridge
outcome separately. Calling raw `adapter.api.run` instead of guarded
`adapter.run` also cannot bypass bridge review, but can unnecessarily leave an
unreviewed write uncertain. A future typed tool outcome contract could represent
that distinction durably; this change does not alter the parent-owned runner.

## Still required before any live connection

- Explicit owner setup of a Studio place and its built-in MCP connection,
  followed by owner selection of the intended session. Existing owner steps
  are recorded in [the bridge README](../../../packages/studio-bridge/README.md).
- A reviewed real local SDK/stdio transport with framing limits, negotiation,
  disconnect handling, cancellation and teardown. The supplied transport is
  in-memory; no process is launched. Hosted access separately needs a reviewed
  helper pairing/authorization design and authenticated owner/project routing.
- Actual installed Studio capability/schema inspection and full supported JSON
  Schema validation with safe model-facing projection. The two fixture schemas
  and fixture instance result are not verified live Roblox contracts.
- Authenticated trusted selection and separate exact proposal-review UI/control
  paths, plus durable connection/selection/proposal evidence, review expiry,
  claims, outcomes and restart/replay protection. Runner digest approval must
  remain distinct from bridge digest approval.
- An owner reconciliation procedure for uncertain writes and separately
  authorized read-first validation against an owner-selected test place. Paid
  models, billing, publishing, credentials, plugins, listeners and host changes
  are outside this proof.

The mock integration has no submission/restart/live-compatibility guarantee.
Existing public analytics and free MCP are unaffected.
