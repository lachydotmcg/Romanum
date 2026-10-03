# Durable Studio action workflow — authored fixtures only

This is a code-only next milestone over the inspected Agent API (`93f743a`),
mock integration (`cfcebc7`), Studio bridge (`b337202`) and stdio (`3db9239`).
Those foundations remain separate, local prototypes. This module provides an
owner-controlled request workflow; it does not enable a hosted agent, a real
Studio connection, Luau execution or game editing. No route is mounted.

The isolated branch starts at verified production `8ae07c0`. It includes only
those four foundation commits and this workflow. The dirty main checkout and
another agent's public MCP routes are outside its edit scope.

## Runnable fixture

With the repository's existing dependencies (no new installation):

```sh
node scripts/agent-studio-workflow-demo.mjs
node --test --test-concurrency=1 tests/agent-studio-workflow.test.mjs
node --test --test-concurrency=1 packages/studio-bridge/tests/*.test.mjs tests/agent-api.test.mjs tests/agent-studio-adapter.test.mjs tests/harness.test.mjs tests/harness-wait.test.mjs
npx next typegen
npx tsc --noEmit --incremental false
npx tsc -p packages/studio-bridge/tsconfig.json
npm run lint
```

The demo uses an authored in-memory Studio transport and an isolated PGlite
database. Its only edit changes a fixture string from `return 'red'` to
`return 'blue'`. Repeating execution returns its saved result and proves one
write dispatch. The disk reopen test verifies actual durable storage, not a
new in-memory service pretending to recover state. Stdio regression tests run
only the previously authored fixture child; they do not launch StudioMCP.

`schema.sql` is applied explicitly to test databases after the existing app
migrations. It is **not** part of application migration discovery or startup.
No production database was changed.

## Request contract and authentication boundary

`studioWorkflowResponse` accepts `Request` objects and the existing private
project handler's dependency pattern: current signed-in `account()` and
`isCrossSite(request)`. A future route must supply `readAccount` from
`accounts/session`, not `readOwner`/`ensureOwner`, which admit guest fallback.
The handler resolves identity on every call, rejects cross-site mutations,
checks the configured service belongs to that identity, and validates owned
projects/actions on the server. Bodies cannot set an owner, capability,
connection, approval scope or hidden Studio target. Every response is private
and `no-store`; raw upstream/storage errors and attempt tokens are excluded.
Fixture tests inject authored account results; real session routing is not
deployed or live-validated.

All POST operations carry `projectId`, `key` (1–100 ASCII identifier characters)
and `operation`. The key namespace spans all operations for that owner/project.

| Operation | Additional fields | Behavior |
| --- | --- | --- |
| `select` | `studioId` | Explicit owner selection from discovery; never selects the first session. |
| `inspect` | `selectionId` | Saves a bounded read action and its actual fixture result. |
| `propose` | `inspectionId`, `input` | Saves the exact `multi_edit` proposal after a successful recent inspection. |
| `review` | `actionId`, `digest`, `approve` | Stores an exact owner decision; digest includes project revision, inspection and bridge proposal. |
| `execute` | `actionId` | Claims once and dispatches an approved action; no model can grant approval. |
| `cancel` | `actionId` | Revokes the durable claim before best-effort local abort. |
| `recover` | `actionId` | Revokes only an expired running claim; never redispatches. |

GET requires `projectId`, with optional `actionId`. It returns owned action
evidence or fixture discovery. This is an **unmounted handler contract**, not
a documented operational endpoint. `createFixtureStudioWorkflow` is disabled
unless explicitly enabled and accepts only the authored `MockStudioTransport`.
It does not create credentials, pairing grants, listeners or helpers.

## Durable state, idempotency and recovery

Selections, immutable action proposals, inspection results, owner decisions,
expiry, dispatch phase, attempt claims, outcomes and request receipts persist
in SQL. Identical key/body replay returns the same resource's **current** saved
state. Reusing a key for a different normalized body returns 409. Review and
execute receipts cannot refresh approval or create another attempt.

Writes progress `proposed → approved/rejected → running → succeeded/failed`.
Cancellation before the durable dispatch fence saves `cancelled`; cancellation
or failure after a write dispatch can save `uncertain`. An approved write cannot
execute after cancellation, expiry, project revision changes, archiving,
reselection or reconnect. Reconnect requires new explicit selection, inspection
and review; historical approvals remain readable but cannot be consumed.

The bridge's trusted `beforeDispatch` hook runs after fresh discovery and before
`tools/call`. The service rechecks the live claim, project, expiry and target,
then commits `dispatching` before transport send. A crash between that commit
and send is deliberately ambiguous. Completion must match the current claim
and running state; late responses cannot revive a cancelled/recovered action.
The hook rejection prevents a tool call. Executing an approved write does not
enable `execute_luau`, publish, playtesting, asset upload or image generation.

Approvals expire after 30 seconds; execution leases last 60 seconds. Expiry uses
the database's current wall clock rather than a transaction's start time.
Recovery of an expired pending dispatch is safe cancellation; a dispatching
write becomes uncertain, without automatic retry. Unknown writes block another
write for that owner/project and for the same Studio/place across their other
projects and reconnects. Successful writes require an inspection begun **after
completion**, including when an earlier read overlapped the write. State changes
lock that owner's project rows in stable order to serialize these checks.

Best-effort cancellation notifications do not prove an already dispatched write
stopped or rolled back. Cross-process cancellation may miss a local controller;
the durable claim still fences completion. There is no reconciliation/override
operation in this milestone. An uncertain write remains blocked pending a
separately implemented trusted, evidence-backed operator reconciliation path.

Bounds: 64 KiB streamed HTTP bodies, 30-second approvals, existing bridge message
limits, 256 selections/actions per owner/project and 2,048 request receipts.
Limits fail closed. Receipts are not evicted, since eviction would erase retry
protection. Project deletion cascades this prototype's private records; a release
must verify its account-export and closure integration before enabling storage.

## Minimal live validation and owner steps (not performed)

1. Coordinate integration/deployment with the parent. Turn this isolated SQL
   schema into the next reviewed application migration, verify account export,
   retention/closure and real PostgreSQL concurrency, then wire a private
   session-authenticated handler and an owner review UI showing Studio/place,
   exact edits, inspection evidence and expiry. Keep public MCP separate.
2. With the owner's existing approved local Studio connection, validate only
   discovery and a read in an explicitly chosen disposable/test place: actual
   protocol/tool schemas, selected Studio/place identity and response bounds.
   The fixture validator is not suitable for a real peer. Local Studio stdio
   is not by itself an authenticated hosted-to-desktop channel; that connection
   architecture and owner-established access remain separate work.
3. Before any real write, separately authorize the exact reviewed action and
   target. Validate duplicate delivery, Stop, disconnect and restart behavior
   on that test place, plus verified outcome evidence for operator recovery.
   This task authorizes no real Studio actions, access grants or helper setup.

This code has not been merged, deployed or presented as an operational Studio
integration. Paid model/image calls, credentials and production changes remain
outside this milestone.
