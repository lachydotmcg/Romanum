import { MCP_VERSION } from "../src/protocol.ts";
import type { BridgeTransport, ClientMessage, ClientRequest, Json, JsonObject, ServerResponse } from "../src/protocol.ts";

// Illustrative fixture shapes only. Real tools/list schemas remain authoritative.
export const STATE_SCHEMA: JsonObject = {
  type: "object", properties: { studio_id: { type: "string" } },
  required: ["studio_id"], additionalProperties: false,
};
export const EDIT_SCHEMA: JsonObject = {
  type: "object",
  properties: { studio_id: { type: "string" }, datamodel_type: { type: "string", enum: ["Edit"] }, edits: { type: "array", items: { type: "object" } } },
  required: ["studio_id", "datamodel_type", "edits"], additionalProperties: false,
};

/** Deliberately only validates known fixture schemas. Never use for a real peer. */
export function validateFixtureInput(schema: JsonObject, input: JsonObject): boolean {
  if (JSON.stringify(schema) === JSON.stringify(STATE_SCHEMA)) return Object.keys(input).length === 1 && typeof input.studio_id === "string";
  if (JSON.stringify(schema) !== JSON.stringify(EDIT_SCHEMA)) return false;
  return Object.keys(input).length === 3 && typeof input.studio_id === "string" && input.datamodel_type === "Edit" && Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 10 && input.edits.every((edit) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
    return Object.keys(edit).length === 3 && [edit.path, edit.oldText, edit.newText].every((value) => typeof value === "string");
  });
}

export class MockStudioTransport implements BridgeTransport {
  messages: ClientMessage[] = [];
  toolCalls: Extract<ClientRequest, { method: "tools/call" }>[] = [];
  writes: JsonObject[] = [];
  cancelled: string[] = [];
  sessions: JsonObject[] = [
    { studio_id: "studio-a", name: "Mock place A", place_id: "101" },
    { studio_id: "studio-b", name: "Mock place B", place_id: "202" },
  ];
  tools: JsonObject[] = [
    { name: "list_roblox_studios", inputSchema: { type: "object" } },
    { name: "get_studio_state", inputSchema: STATE_SCHEMA },
    // The false annotation demonstrates why local metadata controls the gate.
    { name: "multi_edit", inputSchema: EDIT_SCHEMA, annotations: { readOnlyHint: true } },
    { name: "execute_luau", inputSchema: STATE_SCHEMA, annotations: { readOnlyHint: true } },
  ];
  hold = new Set<string>();
  beforeReply?: (request: ClientRequest) => void;
  replyOverride?: (request: ClientRequest) => ServerResponse | undefined;
  protocolVersion = MCP_VERSION;
  serverCapabilities: JsonObject = { tools: { listChanged: true } };
  nextCursor: string | undefined;
  closed = false;
  #initialized = false;
  #messages = new Set<(message: unknown) => void>();
  #closes = new Set<() => void>();

  onMessage(listener: (message: unknown) => void): () => void { this.#messages.add(listener); return () => this.#messages.delete(listener); }
  onClose(listener: () => void): () => void { this.#closes.add(listener); return () => this.#closes.delete(listener); }
  emit(message: unknown): void { for (const listener of this.#messages) listener(message); }
  send(message: ClientMessage): void {
    if (this.closed) throw new Error("Fixture disconnected");
    const copy = structuredClone(message);
    this.messages.push(copy);
    if (copy.method === "notifications/initialized") { this.#initialized = true; return; }
    if (copy.method === "notifications/cancelled") { this.cancelled.push(copy.params.requestId); return; }
    if (copy.method === "tools/call") this.toolCalls.push(copy);
    if (this.hold.has(copy.method) || (copy.method === "tools/call" && this.hold.has(copy.params.name))) return;
    queueMicrotask(() => {
      if (this.closed || this.cancelled.includes(copy.id)) return;
      this.beforeReply?.(copy);
      const override = this.replyOverride?.(copy);
      if (override) { this.emit(override); return; }
      let result: Json;
      if (copy.method === "initialize") result = { protocolVersion: this.protocolVersion, capabilities: this.serverCapabilities, serverInfo: { name: "mock-studio", version: "0.1.0" } };
      else if (!this.#initialized) { this.emit({ jsonrpc: "2.0", id: copy.id, error: { code: -32600, message: "Not initialized" } }); return; }
      else if (copy.method === "tools/list") result = { tools: this.tools, ...(this.nextCursor === undefined ? {} : { nextCursor: this.nextCursor }) };
      else if (copy.params.name === "list_roblox_studios") result = { structuredContent: { studios: this.sessions }, content: [] };
      else if (!this.sessions.some((session) => session.studio_id === copy.params.arguments.studio_id)) result = { isError: true, content: [{ type: "text", text: "Wrong Studio" }] };
      else if (copy.params.name === "get_studio_state") result = { structuredContent: { studio_id: copy.params.arguments.studio_id, playState: "Stopped", mock: true }, content: [] };
      else if (copy.params.name === "multi_edit") {
        this.writes.push(structuredClone(copy.params.arguments));
        result = { structuredContent: { applied: true, mock: true }, content: [] };
      } else result = { isError: true, content: [] };
      this.emit(structuredClone({ jsonrpc: "2.0", id: copy.id, result }));
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#closes) listener();
    this.#messages.clear();
    this.#closes.clear();
  }
}
