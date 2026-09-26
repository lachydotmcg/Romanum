import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { connectStudio, createStudioConnection, StudioConnectorError } from "../src/lib/harness/studio.ts";

// A fake MCP client stands in for the official one. Nothing here spawns a
// process, talks to Studio, or makes any network call.

const studioSchema = (properties = {}, required = []) => ({
  type: "object",
  properties: { studio_id: { type: "string" }, ...properties },
  required: ["studio_id", ...required],
  additionalProperties: false,
});

const defaultTools = () => [
  { name: "list_roblox_studios", description: "remote", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_studio_state", description: "remote", inputSchema: studioSchema(), annotations: { readOnlyHint: false } },
  { name: "search_game_tree", description: "remote", inputSchema: studioSchema({ query: { type: "string" } }, ["query"]) },
  { name: "inspect_instance", description: "remote", inputSchema: studioSchema({ path: { type: "string" } }, ["path"]) },
  { name: "script_read", description: "remote", inputSchema: studioSchema({ path: { type: "string" } }, ["path"]) },
  { name: "script_search", description: "remote", inputSchema: studioSchema({ query: { type: "string" } }, ["query"]) },
  { name: "script_grep", description: "remote", inputSchema: studioSchema({ pattern: { type: "string" } }, ["pattern"]) },
  { name: "get_console_output", description: "remote", inputSchema: studioSchema() },
  { name: "multi_edit", description: "remote", inputSchema: studioSchema({ edits: { type: "array", items: { type: "object" } } }, ["edits"]), annotations: { readOnlyHint: true } },
  { name: "execute_luau", description: "remote", inputSchema: studioSchema({ code: { type: "string" } }, ["code"]) },
  { name: "play_game", description: "remote", inputSchema: studioSchema(), annotations: { readOnlyHint: true } },
  { name: "upload_asset", description: "remote", inputSchema: studioSchema() },
  { name: "spawn_subagent", description: "remote", inputSchema: studioSchema() },
  { name: "generate_image", description: "remote", inputSchema: studioSchema() },
];

const EXPECTED_TOOL_NAMES = [
  "studio_execute_luau",
  "studio_get_console_output",
  "studio_get_studio_state",
  "studio_inspect_instance",
  "studio_multi_edit",
  "studio_script_grep",
  "studio_script_read",
  "studio_script_search",
  "studio_search_game_tree",
];

function createFakeClient(tools = defaultTools(), options = {}) {
  const calls = [];
  const state = { closed: false };
  return {
    calls,
    state,
    tools,
    async listTools(params) {
      if (state.closed) throw new Error("fake client is closed");
      if (options.listTools) {
        const result = await options.listTools(params, tools);
        if (result !== undefined) return result;
      }
      return { tools: tools.map((tool) => ({ ...tool })) };
    },
    async callTool(params) {
      if (state.closed) throw new Error("fake client is closed");
      calls.push(params);
      if (options.callTool) {
        const result = await options.callTool(params, tools, state);
        if (result !== undefined) return result;
      }
      if (params.name === "list_roblox_studios") {
        return {
          structuredContent: {
            studios: [
              { id: "studio-a", name: "Place A" },
              { id: "studio-b", name: "Place B" },
            ],
          },
        };
      }
      return { structuredContent: { tool: params.name }, content: [{ type: "text", text: "done" }] };
    },
    async close() {
      state.closed = true;
    },
  };
}

const context = (signal) => ({ ownerId: "o", projectId: "p", runId: "r", actionId: "a", signal: signal ?? new AbortController().signal });
const byName = (tools, name) => tools.find((tool) => tool.name === name);
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("exposes only the allowlisted tools with authoritative effects", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });

  assert.deepEqual(await connection.listStudios(), [
    { id: "studio-a", name: "Place A" },
    { id: "studio-b", name: "Place B" },
  ]);

  const tools = await connection.tools("studio-a");
  assert.deepEqual([...tools.map((tool) => tool.name)].sort(), EXPECTED_TOOL_NAMES);
  assert.ok(tools.every((tool) => tool.scope === "studio"));

  for (const name of ["studio_get_studio_state", "studio_search_game_tree", "studio_inspect_instance", "studio_script_read", "studio_script_search", "studio_script_grep", "studio_get_console_output"]) {
    assert.equal(byName(tools, name).effect, "read", `${name} is read`);
  }
  assert.equal(byName(tools, "studio_multi_edit").effect, "write");
  assert.equal(byName(tools, "studio_execute_luau").effect, "execute");

  // Never trust annotations: a read tool annotated as mutating stays "read",
  // and a write tool annotated read-only stays "write".
  assert.equal(byName(tools, "studio_get_studio_state").effect, "read");
  assert.equal(byName(tools, "studio_multi_edit").effect, "write");

  // Unlisted tools never reach the model.
  for (const name of ["studio_play_game", "studio_upload_asset", "studio_spawn_subagent", "studio_generate_image", "studio_list_roblox_studios"]) {
    assert.equal(byName(tools, name), undefined, `${name} is not exposed`);
  }
});

test("pins studio_id and strips it from the model-facing schema", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  assert.equal(Object.prototype.hasOwnProperty.call(state.inputSchema.properties, "studio_id"), false);
  assert.deepEqual(state.inputSchema.required ?? [], []);
  assert.equal(JSON.stringify(state.inputSchema).includes("studio_id"), false);

  assert.deepEqual(state.parse({}), {});
  assert.throws(() => state.parse({ studio_id: "studio-b" }), (error) => error.code === "invalid_input");

  const studioCalls = () => client.calls.filter((call) => call.name === "get_studio_state");
  await state.execute({}, context());
  assert.equal(studioCalls().length, 1);
  assert.deepEqual(studioCalls()[0].arguments, { studio_id: "studio-a" });

  // A model-supplied studio_id is rejected before it reaches the server.
  await rejectsCode(state.execute({ studio_id: "studio-b" }, context()), "invalid_input");
  assert.equal(studioCalls().length, 1);
});

test("rejects invalid or unavailable studio ids", async () => {
  const connection = createStudioConnection(createFakeClient(), { identity: "conn-1" });
  await rejectsCode(connection.tools(""), "unknown_studio");
  await rejectsCode(connection.tools("studio-z"), "unknown_studio");
  await rejectsCode(connection.tools(42), "unknown_studio");
});

test("validates tool input with AJV", async () => {
  const connection = createStudioConnection(createFakeClient(), { identity: "conn-1" });
  const inspect = byName(await connection.tools("studio-a"), "studio_inspect_instance");

  assert.throws(() => inspect.parse({}), (error) => error.code === "invalid_input");
  assert.throws(() => inspect.parse({ path: 5 }), (error) => error.code === "invalid_input");
  assert.throws(() => inspect.parse({ path: "Workspace", extra: true }), (error) => error.code === "invalid_input");
  assert.deepEqual(inspect.parse({ path: "Workspace" }), { path: "Workspace" });
});

test("rejects a changed descriptor between listing and call", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  const remote = client.tools.find((tool) => tool.name === "get_studio_state");
  remote.inputSchema.properties.extra = { type: "string" };

  await rejectsCode(state.execute({}, context()), "tool_changed");
});

test("rejects a tool that disappears after listing", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  const index = client.tools.findIndex((tool) => tool.name === "get_studio_state");
  client.tools.splice(index, 1);

  await rejectsCode(state.execute({}, context()), "unknown_tool");
});

test("connection identity changes the tool version so approvals invalidate", async () => {
  const client = createFakeClient();
  const one = byName(await createStudioConnection(client, { identity: "conn-1" }).tools("studio-a"), "studio_get_studio_state");
  const again = byName(await createStudioConnection(client, { identity: "conn-1" }).tools("studio-a"), "studio_get_studio_state");
  const other = byName(await createStudioConnection(client, { identity: "conn-2" }).tools("studio-a"), "studio_get_studio_state");
  const random = byName(await createStudioConnection(client).tools("studio-a"), "studio_get_studio_state");

  assert.equal(one.version, again.version);
  assert.notEqual(one.version, other.version);
  assert.notEqual(one.version, random.version);
});

test("bounds the schema and the input", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  await rejectsCode(state.execute({ big: "x".repeat(70 * 1024) }, context()), "input_too_large");
});

test("skips tools whose schema is too large", async () => {
  const tools = defaultTools();
  const huge = tools.find((tool) => tool.name === "script_read");
  huge.inputSchema.properties.blob = { type: "string", description: "y".repeat(40 * 1024) };

  const connection = createStudioConnection(createFakeClient(tools), { identity: "conn-1" });
  const exposed = await connection.tools("studio-a");
  assert.equal(byName(exposed, "studio_script_read"), undefined);
  assert.ok(byName(exposed, "studio_get_studio_state"));
});

test("bounds the tool output", async () => {
  const client = createFakeClient(defaultTools(), {
    callTool: (params) => (params.name === "get_studio_state" ? { structuredContent: { big: "x".repeat(70 * 1024) } } : undefined),
  });
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  await rejectsCode(state.execute({}, context()), "output_too_large");
});

test("sanitizes upstream failures and tool errors", async () => {
  const throwing = createFakeClient(defaultTools(), {
    callTool: (params) => {
      if (params.name === "get_studio_state") throw new Error("SECRET-UPSTREAM-BODY");
      return undefined;
    },
  });
  const connection = createStudioConnection(throwing, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");
  await assert.rejects(state.execute({}, context()), (error) => {
    assert.ok(error instanceof StudioConnectorError);
    assert.equal(error.code, "upstream_failed");
    assert.ok(!String(error.message).includes("SECRET"));
    assert.equal(error.cause, undefined);
    return true;
  });

  const erroring = createFakeClient(defaultTools(), {
    callTool: (params) => (params.name === "get_studio_state" ? { isError: true, content: [{ type: "text", text: "SECRET-UPSTREAM-BODY" }] } : undefined),
  });
  const erroringConnection = createStudioConnection(erroring, { identity: "conn-1" });
  const erroringState = byName(await erroringConnection.tools("studio-a"), "studio_get_studio_state");
  await assert.rejects(erroringState.execute({}, context()), (error) => {
    assert.equal(error.code, "tool_error");
    assert.ok(!String(error.message).includes("SECRET"));
    return true;
  });
});

test("drops non-text content from tool output", async () => {
  const client = createFakeClient(defaultTools(), {
    callTool: (params) =>
      params.name === "get_studio_state"
        ? { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "kept" }] }
        : undefined,
  });
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");
  const output = await state.execute({}, context());
  assert.deepEqual(output, { structuredContent: null, text: "kept" });
});

test("rejects malformed discovery results", async () => {
  const missing = defaultTools().filter((tool) => tool.name !== "list_roblox_studios");
  const noDiscovery = createStudioConnection(createFakeClient(missing), { identity: "conn-1" });
  await rejectsCode(noDiscovery.listStudios(), "discovery_unavailable");

  const badBody = createFakeClient(defaultTools(), {
    callTool: (params) => (params.name === "list_roblox_studios" ? { structuredContent: { studios: [{ nope: true }] } } : undefined),
  });
  await rejectsCode(createStudioConnection(badBody, { identity: "conn-1" }).listStudios(), "discovery_failed");
});

test("reads sessions from a text-only discovery result", async () => {
  const client = createFakeClient(defaultTools(), {
    callTool: (params) =>
      params.name === "list_roblox_studios" ? { content: [{ type: "text", text: JSON.stringify([{ studio_id: "s1" }]) }] } : undefined,
  });
  const connection = createStudioConnection(client, { identity: "conn-1" });
  assert.deepEqual(await connection.listStudios(), [{ id: "s1" }]);
});

test("bounds pagination, duplicates and cursor cycles", async () => {
  let unique = 0;
  const paged = createFakeClient(defaultTools(), {
    listTools: () => {
      unique += 1;
      return { tools: [{ name: `tool_${unique}`, description: "", inputSchema: { type: "object" } }], nextCursor: `cursor_${unique}` };
    },
  });
  await rejectsCode(createStudioConnection(paged, { identity: "conn-1" }).listStudios(), "list_too_large");

  const duplicated = createFakeClient(defaultTools(), {
    listTools: () => ({ tools: [{ name: "dup", description: "", inputSchema: { type: "object" } }, { name: "dup", description: "", inputSchema: { type: "object" } }] }),
  });
  await rejectsCode(createStudioConnection(duplicated, { identity: "conn-1" }).listStudios(), "list_duplicate");

  let cycle = 0;
  const looping = createFakeClient(defaultTools(), {
    listTools: () => {
      cycle += 1;
      return { tools: [{ name: `tool_${cycle}`, description: "", inputSchema: { type: "object" } }], nextCursor: "same" };
    },
  });
  await rejectsCode(createStudioConnection(looping, { identity: "conn-1" }).listStudios(), "cursor_cycle");

  const tooMany = createFakeClient(defaultTools(), {
    listTools: () => ({ tools: Array.from({ length: 51 }, (_, index) => ({ name: `t${index}`, description: "", inputSchema: { type: "object" } })) }),
  });
  await rejectsCode(createStudioConnection(tooMany, { identity: "conn-1" }).listStudios(), "list_too_large");
});

test("closed connections reject every call", async () => {
  const client = createFakeClient();
  const connection = createStudioConnection(client, { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");

  await connection.close();
  await connection.close();
  assert.equal(client.state.closed, true);

  await rejectsCode(connection.listStudios(), "connection_closed");
  await rejectsCode(connection.tools("studio-a"), "connection_closed");
  await rejectsCode(state.execute({}, context()), "connection_closed");
});

test("an aborted signal cancels execution", async () => {
  const connection = createStudioConnection(createFakeClient(), { identity: "conn-1" });
  const state = byName(await connection.tools("studio-a"), "studio_get_studio_state");
  const controller = new AbortController();
  controller.abort();
  await rejectsCode(state.execute({}, context(controller.signal)), "aborted");
});

test("connectStudio refuses invalid executables without spawning a process", async () => {
  await rejectsCode(connectStudio("relative/StudioMCP.exe", true), "invalid_executable");
  await rejectsCode(connectStudio("C:\\missing\\StudioMCP.exe", true), "invalid_executable");
  await rejectsCode(connectStudio("StudioMCP.exe", true), "invalid_executable");
  await rejectsCode(connectStudio(fileURLToPath(import.meta.url), true), "invalid_executable");
});

test("connectStudio is inert while disabled", async () => {
  await rejectsCode(connectStudio(fileURLToPath(import.meta.url), false), "studio_disabled");
  await rejectsCode(connectStudio("C:\\missing\\StudioMCP.exe", false), "studio_disabled");
});

test("declared modern JSON Schema constraints are preserved", async () => {
  const client = createFakeClient();
  const remote = client.tools.find((tool) => tool.name === "get_studio_state");
  remote.inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
  remote.inputSchema.properties.a = { type: "string" };
  remote.inputSchema.properties.b = { type: "string" };
  remote.inputSchema.dependentRequired = { a: ["b"] };
  const state = byName(await createStudioConnection(client).tools("studio-a"), "studio_get_studio_state");
  assert.throws(() => state.parse({ a: "one" }), (error) => error.code === "invalid_input");
  assert.deepEqual(state.parse({ a: "one", b: "two" }), { a: "one", b: "two" });
});

test("changed descriptions invalidate calls and tool discovery bypasses stale caches", async () => {
  const client = createFakeClient();
  const originalList = client.listTools.bind(client);
  client.listTools = (params, options) => { assert.equal(options.cacheMode, "refresh"); return originalList(params); };
  const state = byName(await createStudioConnection(client).tools("studio-a"), "studio_get_studio_state");
  client.tools.find((tool) => tool.name === "get_studio_state").description = "Changed semantics";
  await rejectsCode(state.execute({}, context()), "tool_changed");
});

test("unexpected discovery is an error, while a real empty list is valid", async () => {
  for (const body of [{}, { content: [{ type: "text", text: "Not a list" }] }]) {
    const client = createFakeClient(defaultTools(), { callTool: () => body });
    await rejectsCode(createStudioConnection(client).listStudios(), "discovery_failed");
  }
  const client = createFakeClient(defaultTools(), { callTool: () => ({ structuredContent: { studios: [] } }) });
  assert.deepEqual(await createStudioConnection(client).listStudios(), []);
});

test("cancellation during refresh prevents the eventual Studio action", async () => {
  const client = createFakeClient();
  const state = byName(await createStudioConnection(client).tools("studio-a"), "studio_get_studio_state");
  let entered, finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const stalled = new Promise((resolve) => { finish = resolve; });
  client.listTools = async () => { entered(); return stalled; };
  const controller = new AbortController();
  const action = state.execute({}, context(controller.signal));
  await started;
  controller.abort();
  await rejectsCode(action, "aborted");
  finish({ tools: defaultTools() });
  assert.equal(client.calls.filter(({ name }) => name === "get_studio_state").length, 0);
});
