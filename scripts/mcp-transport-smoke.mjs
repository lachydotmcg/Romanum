import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Protocol-only release check: discovery and repository metric definitions, no upstream data or paid calls.
const endpoint = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
if (endpoint.username || endpoint.password) throw new Error("Use an endpoint URL without credentials.");
let failed = false;
for (const mode of ["legacy", { pin: "2026-07-28" }]) {
  const client = new Client({ name: "romanum-transport-smoke", version: "1" }, { versionNegotiation: { mode } });
  const exchanges = [];
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
        let method;
        try { method = JSON.parse(init?.body ?? "{}").method; } catch { /* The transport may provide a Request body. */ }
        const rejectedBody = response.ok ? undefined : (await response.clone().text()).slice(0, 300);
        exchanges.push({ method, status: response.status, requestId: response.headers.get("x-nf-request-id"), ...(rejectedBody ? { rejectedBody } : {}) });
        return response;
      },
    }));
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, "server advertises public tools");
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    const result = await client.callTool({ name: "get_metric_definitions", arguments: {} });
    assert.ok(!result.isError, "metric definitions tool succeeds");
    assert.equal(result.structuredContent.metrics.playing.unit, "players");
    console.log(JSON.stringify({ endpoint: endpoint.href, mode, pass: true, tools: tools.length, exchanges }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ endpoint: endpoint.href, mode, pass: false, error: error.message, exchanges }));
  } finally {
    await client.close();
  }
}
if (failed) process.exitCode = 1;
