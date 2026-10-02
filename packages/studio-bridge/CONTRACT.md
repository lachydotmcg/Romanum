# Agent API handoff: Studio bridge v0.1

Entrypoint: `packages/studio-bridge/src/index.ts`. Process-local scaffold; no production registration or live transport. The job API worker can depend on these shapes without editing this package's files.

| Operation | Result / boundary |
| --- | --- |
| `new StudioBridge(transport, { validateInput, timeoutMs? })` | Requires trusted local transport and synchronous fail-closed schema validation. |
| `initialize({ signal?, timeoutMs? })` | Negotiates the fixture's MCP subset. Production SDK adapter remains future work. |
| `discover({ signal?, timeoutMs? })` | `{ connectionId, sessions, capabilities }`; bounded, fresh snapshot. |
| `selectStudio(studioId)` | Trusted owner-only operation; returns `StudioTarget`. Never auto-select. |
| `prepareAction({ actionId, target, tool, version, input })` | Returns copied `ActionProposal` with digest; no action dispatch. |
| `reviewAction(actionId, digest, approve)` | Trusted owner-only write decision. Never expose to a model. |
| `execute(actionId, { signal?, timeoutMs? })` | Uses stored proposal only; refreshes target/capability before dispatch. |
| `actionStatus(actionId)` | `proposed / approved / rejected / running / succeeded / failed / uncertain`. |
| `close()` | Ends local pending waits and invalidates this connection. |

```ts
type StudioTarget = {
  connectionId: string; selectionId: string; studioId: string;
  name?: string; placeId?: string;
};
type ActionProposal = {
  actionId: string; target: StudioTarget;
  tool: "get_studio_state" | "multi_edit";
  effect: "read" | "write"; version: string;
  input: JsonObject; digest: string; requiresConfirmation: boolean;
};
```

The SHA-256 proposal digest covers all fields other than `digest`, with recursively sorted object keys. The capability version additionally binds the connection, local effect and exact remote descriptor. Treat both values as opaque and use the bridge-returned proposal in the review UI. Do not reconstruct a weaker digest or accept a model-supplied effect/version/target as authority.

The API controller must derive `actionId` from its authenticated owner/project/run/action record and enforce allowed tools. Persist bridge proposals and claims in its own job workflow when that is implemented. Studio selection and write review are separate trusted controller paths, with ownership enforced outside this scaffold. A process restart requires a new connection, selection, proposal and review; the new instance is not a durable deduplication system.

This package's `inputSchema` is the **full remote schema**, including `studio_id`. It is for validation/integration metadata. For model-facing `HarnessTool` descriptors, follow the existing Studio connector's schema projection: remove model control over `studio_id` while preserving supported constraints, or fail closed. The bridge always injects the selected ID. The existing harness fields map as follows: `scope = "studio"`, `effect` is local metadata, `target.studioId` is pinned, and `version` is the bridge capability version. A future wrapper must keep connection/selection/digest evidence alongside the existing runner record rather than silently treat its current digest as bridge approval.

Errors expose only `BridgeError.code` and `outcome`. A rejected/unconfirmed write dispatches nothing. `outcome = "not_dispatched"` means the action call did not start; `"failed"` denotes a dispatched read failure; `"unknown"` denotes a dispatched write whose effects need owner reconciliation. RPC/tool errors can also leave writes uncertain. Never automatically retry an uncertain write, reuse a terminal action ID, or describe cancellation as rollback.

The only supplied transport is a local mock; live stdio, helper pairing, authenticated API endpoints, durable job storage, installer and hosted routing remain separate ownership/work. See [README.md](README.md) for exact owner setup steps and limitations.
