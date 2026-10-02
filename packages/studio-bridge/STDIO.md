# Reviewed local stdio adapter

This slice adds `src/transport/index.ts` beneath the existing bridge. The bridge's public entrypoint, protocol, proposal digest and approval behavior are unchanged. The [v0.1 handoff](CONTRACT.md) still applies; its transport-future-work note describes the earlier mock-only revision. This document records the newly implemented adapter and remaining live-access work.

The executable demonstration starts only `fixtures/stdio-server.mjs`, authored in this repository, with the current Node executable. It communicates through stdin/stdout pipes. It has no listeners, game access, file writes, credentials or descendants. All mock edits are records in child-process memory. Real-server construction defaults to disabled and was never activated.

## Run the fixture

Use the existing repository's lockfile-managed MCP dependencies and Node 24. No installation is needed for the original in-memory tests. The stdio tests additionally load the already installed official MCP SDK. From this worktree's repository root:

```powershell
# Only if this isolated worktree has no own node_modules:
$env:ROMANUM_BRIDGE_SDK_ROOT = 'C:\dev\romanum'
node --test --test-concurrency=1 packages/studio-bridge/tests/*.test.mjs
node packages/studio-bridge/fixtures/stdio-demo.mjs
```

The optional environment value selects an existing local dependency-resolution anchor for tests/demo; it is not forwarded to the child. With this worktree's normal repository dependencies available, omit it. Run the two test files serially: the original in-memory suite intentionally uses deadlines as short as 20–40 ms and can fail under concurrent SDK compilation or process startup. No new package, lockfile, executable, plugin or service was installed in this slice. The existing root test command still does not include package tests.

## Ownership and responsibilities

```ts
import { StudioBridge } from './src/index.ts';
import { loadInstalledMcpSdk, createFixtureStdioTransport } from './src/transport/index.ts';

const transport = createFixtureStdioTransport(loadInstalledMcpSdk());
const bridge = new StudioBridge(transport, { validateInput: transport.validateInput });
try {
  await transport.start();
  await bridge.initialize(); // Exactly once; no SDK Client.connect() handshake.
  const discovery = await bridge.discover();
  const target = bridge.selectStudio('studio-b'); // Explicit fixture owner selection.
  // prepareAction / owner reviewAction / execute retain the existing contract.
} finally {
  bridge.close();
  await transport.waitForClose(); // Wait for owned child cleanup; never restart it.
}
```

`StudioBridge` continues to own negotiation, capabilities, Studio selection, action correlation, total deadlines, cancellation, confirmation and dispatched-write uncertainty. The adapter implements `BridgeTransport`, synchronously accepts a bounded outbound queue, validates typed messages/results using the official SDK schemas, and supplies an SDK-backed `validateInput` callback. It does not instantiate an SDK Client and cannot negotiate a second session by accident.

The native pipe adapter follows [official MCP stdio framing](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): one UTF-8 JSON-RPC message per newline; diagnostics stay on stderr. Inspection of the already installed SDK 2.1.0 showed its `ReadBuffer` silently skips syntax-invalid JSON lines. This adapter instead rejects malformed JSON/UTF-8/envelopes, closes the bridge immediately, and reaps its child. It uses the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) for protocol schemas, JSON Schema meta-validation, input validation and its filtered default environment. No third-party implementation was downloaded.

Raw frames are checked against 128 KiB before copying/parsing, including incomplete frames. Outbound queue accounting includes the active write and is capped at 512 KiB. Pending requests are capped at 16, unique request IDs at 10,000 per connection, and notifications/server replies at 20,000. Duplicate outbound IDs are rejected; unexpected, duplicate and cancelled response IDs are ignored. No request or child is automatically retried. The bridge retains its independent limits.

Stderr is continuously drained and discarded without logs or accumulation. Neither API keys nor `NODE_OPTIONS`/`NODE_PATH` are inherited by the fixture. The fixed launch uses `shell: false`, a hidden Windows process, explicit cwd, pipes and no detached process. No arbitrary command string or model-owned executable field exists. The public factories accept either a fixed fixture mode or separately trusted owner configuration; the launch implementation is private.

On close, pending bridge waiters end immediately, then the adapter ends child stdin. It signals only its retained child-process handle with SIGTERM after 100 ms and SIGKILL after 300 ms if still alive. `waitForClose()` waits for reaping; after 1,300 ms it reports `shutdown_timeout` rather than claim success. It destroys owned pipes on observed exit and never enumerates/kills unrelated processes or modifies security settings. A child that starts its own long-lived descendants is outside the reviewed launch model; do not approve such a launcher silently.

The adapter answers [server ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping) with an empty result. Other server requests receive a fixed method-not-supported error. Roots, filesystem reads, sampling, elicitation and shell capabilities are never negotiated. These responses remain bounded and do not broaden the bridge's tools.

## Schema policy

The SDK's default provider supports more JSON Schema features than this bounded adapter enables. The adapter first validates the meta-schema and permits only default/explicit 2020-12 object roots with basic types, properties/required, additionalProperties, homogeneous items, enum/const, numeric/string/array bounds and title/description/default annotations. It caps schemas at 32 KiB, 128 schema nodes, depth 12, 100 enum entries and 64 compiled schemas per transport. Input validation preserves types and does not coerce, remove or insert values.

Unknown keywords, regex/patterns, formats, references/remote URLs, other dialects, conditionals and combinatorial schemas fail closed. This avoids silently ignoring constraints, fetching external schema resources or running uncontrolled regex/reference validation. `tools/list` schemas for the two allowed actions are checked before model proposals. Optional output schemas are captured at request enqueue and checked against structured results. A new tool-list snapshot clears removed schemas. Compatibility with an installed Studio's real schemas remains unverified; extending the supported subset needs reviewed fixtures/tests, not a relaxed validator.

## Later owner activation

These steps were not performed:

1. The owner installs/updates official Roblox Studio, opens an authorized test place and enables **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**. No third-party plugin is needed for the built-in path. [Roblox setup](https://create.roblox.com/docs/studio/mcp)
2. The owner reviews their installed Studio's documented connection configuration and verifies the actual native `StudioMCP.exe` path on Windows (`StudioMCP` on macOS). This adapter accepts an absolute existing native file with that name and zero arguments. It deliberately does not run Roblox's documented Windows batch wrapper or accept `cmd.exe`, scripts, shell strings or an arbitrary launcher. If only wrapper-based setup is available, stop and review a native-path resolver separately; do not bypass the gate or rename another program.
3. A trusted local controller, outside model tools, supplies `{ enabled: true, executable: <owner-verified absolute native path> }` to `createOwnerStdioTransport(config, sdk)`. Construct the existing bridge with `transport.validateInput`, subscribe via the bridge before `start()`, then call `initialize()` exactly once. There is no environment switch, auto-discovery, autostart, hosted route or CLI that activates this path today.
4. With separate live-read authorization, inspect the installed server's negotiated version, `tools/list` and session response shapes. The bridge currently pins `2025-11-25`; incompatibility must fail closed. Verify schema compatibility, explicitly select the owner's Studio/place, and perform a read first. No real-server or end-to-end compatibility is claimed by fixture results.
5. Complete authenticated owner/project/run authorization, durable claims/reviews and restart reconciliation in the separate agent API controller before enabling live writes. Preserve the bridge digest and exact target; the transport cannot approve actions. A timeout/cancellation/crash after write enqueue can leave effects unknown. Inspect Studio before any new proposal and never automatically replay an uncertain write.
6. Await `waitForClose()` on shutdown and surface cleanup failure. Hosted Romanum-to-desktop pairing/helper deployment remains separate reviewed work; this adapter establishes only local pipes and does not open a network connection or persist a service.

The tests cover malformed JSON/RPC/schema, unexpected IDs, child crash, timeout/cancellation, framed/unframed size limits, missing capabilities, EOF-resistant cleanup, split UTF-8, discarded diagnostics, ping/denied roots access and prevention of duplicate mock writes.
