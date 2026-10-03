import { createHash, randomUUID } from "node:crypto";
import { BridgeError, MCP_VERSION } from "./protocol.ts";
import type {
  ActionProposal, ActionStatus, ActionTool, BridgeCapability,
  BridgeTransport, ClientMessage, ClientRequest, Discovery, Json, JsonObject,
  StudioSession, StudioTarget,
} from "./protocol.ts";

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_PENDING = 16;
const MAX_REQUESTS = 10_000;
const MAX_ACTIONS = 256;
const MAX_TIMEOUT_MS = 30_000;
// Local policy, independent of remote annotations. No execution/publish tools.
const EFFECTS = Object.freeze({ get_studio_state: "read", multi_edit: "write" } as const);

export interface BridgeOptions {
  /** Trusted JSON Schema validator, e.g. the existing connector's Ajv validator.
   * Must reject unsupported dialects/keywords, never mutate input, and be bounded.
   * The fixture validator only accepts its own known schemas; it is not for Studio.
   */
  validateInput: (schema: JsonObject, input: JsonObject) => boolean;
  timeoutMs?: number;
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ExecuteOptions extends RequestOptions {
  /** Trusted durable caller: commit its attempt/dispatch fence after discovery,
   * before tools/call. Throwing prevents dispatch. Never a remote/model callback.
   */
  beforeDispatch?: () => Promise<void>;
}
type Pending = { resolve: (result: Json) => void; reject: (error: BridgeError) => void; cleanup: () => void };
type ActionRecord = { proposal: ActionProposal; status: ActionStatus };
type RequestBody = ClientRequest extends infer R ? R extends ClientRequest ? Omit<R, "jsonrpc" | "id"> : never : never;

function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** Strict JSON copy: reject functions, nonfinite numbers, getters, cycles/deep data. */
function json(value: unknown, limit = MAX_MESSAGE_BYTES): Json {
  function visit(item: unknown, depth: number): Json {
    if (depth > 20) throw new BridgeError("limit_exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (!object(item)) throw new BridgeError("invalid_input");
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item));
    return Object.fromEntries(entries.map(([key, descriptor]) => {
      if (!("value" in descriptor)) throw new BridgeError("invalid_input");
      return [key, visit(descriptor.value, depth + 1)];
    }));
  }
  const copy = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > limit) throw new BridgeError("limit_exceeded");
  return copy;
}
function jsonObject(value: unknown, limit?: number): JsonObject {
  const copy = json(value, limit);
  if (!object(copy)) throw new BridgeError("invalid_input");
  return copy as JsonObject;
}
function digest(value: Json): string {
  function canonical(item: Json): Json {
    if (Array.isArray(item)) return item.map(canonical);
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key] as Json)]));
    return item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200; }
function toolName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function timeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) throw new BridgeError("invalid_input");
  return value;
}
function safeError(error: unknown): BridgeError { return error instanceof BridgeError ? error : new BridgeError("protocol_error"); }

/** In-process foundation. All public data are copies; internal records own policy. */
export class StudioBridge {
  #connectionId = randomUUID();
  #transport: BridgeTransport;
  #validate: BridgeOptions["validateInput"];
  #timeout: number;
  #state: "new" | "connecting" | "ready" | "closed" = "new";
  #sequence = 0;
  #pending = new Map<string, Pending>();
  #actions = new Map<string, ActionRecord>();
  #snapshot: Discovery | undefined;
  #selected: StudioTarget | undefined;
  #unsubscribe: (() => void)[];

  constructor(transport: BridgeTransport, options: BridgeOptions) {
    if (typeof options.validateInput !== "function") throw new BridgeError("invalid_input");
    this.#timeout = timeout(options.timeoutMs ?? 5_000);
    this.#transport = transport;
    this.#validate = options.validateInput;
    this.#unsubscribe = [transport.onMessage((message) => this.#receive(message)), transport.onClose(() => this.#disconnect())];
  }

  get connectionId(): string { return this.#connectionId; }

  async initialize(options: RequestOptions = {}): Promise<void> {
    if (this.#state !== "new") throw new BridgeError(this.#state === "closed" ? "disconnected" : "not_ready");
    this.#state = "connecting";
    try {
      const result = await this.#request({ method: "initialize", params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "romanum-studio-bridge-mock", version: "0.1.0" } } }, this.#deadline(options), options.signal);
      if (!object(result) || result.protocolVersion !== MCP_VERSION) throw new BridgeError("unsupported_protocol");
      if (!object(result.capabilities) || !object(result.capabilities.tools)) throw new BridgeError("capabilities_unavailable");
      this.#ensureOpen();
      this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.#state = "ready";
    } catch (error) {
      this.close();
      throw safeError(error);
    }
  }

  async discover(options: RequestOptions = {}): Promise<Discovery> {
    this.#ensureReady();
    this.#snapshot = undefined;
    const snapshot = await this.#discover(this.#deadline(options), options.signal);
    this.#snapshot = snapshot;
    return json(snapshot) as unknown as Discovery;
  }

  /** Trusted owner selection, never a model tool. No default/first-Studio choice. */
  selectStudio(studioId: string): StudioTarget {
    this.#ensureReady();
    const session = this.#snapshot?.sessions.find((item) => item.studioId === studioId);
    if (!session) throw new BridgeError("wrong_studio");
    this.#selected = { ...session, connectionId: this.connectionId, selectionId: randomUUID() };
    return { ...this.#selected };
  }

  prepareAction(input: { actionId: string; target: StudioTarget; tool: ActionTool; version: string; input: JsonObject }): ActionProposal {
    this.#ensureReady();
    if (!id(input.actionId)) throw new BridgeError("invalid_input");
    if (this.#actions.has(input.actionId)) throw new BridgeError("duplicate_action");
    if (this.#actions.size >= MAX_ACTIONS) throw new BridgeError("limit_exceeded");
    this.#checkTarget(input.target);
    if (this.#snapshot && !this.#snapshot.sessions.some((session) => digest(json(session)) === digest(json(this.#session(input.target))))) throw new BridgeError("wrong_studio");
    const capability = this.#snapshot?.capabilities.find((item) => item.name === input.tool);
    if (!capability) throw new BridgeError("unknown_tool");
    if (capability.version !== input.version) throw new BridgeError("capability_changed");
    const args = jsonObject(input.input, MAX_INPUT_BYTES);
    if (Object.hasOwn(args, "studio_id")) throw new BridgeError("invalid_input");
    this.#validateArgs(capability.inputSchema, { ...args, studio_id: input.target.studioId });
    const content = { actionId: input.actionId, target: { ...this.#selected! }, tool: capability.name, effect: capability.effect, version: capability.version, input: args, requiresConfirmation: capability.requiresConfirmation };
    const proposal: ActionProposal = { ...content, digest: digest(json(content)) };
    this.#actions.set(input.actionId, { proposal, status: "proposed" });
    return json(proposal) as unknown as ActionProposal;
  }

  /** Trusted owner review boundary; do not expose this method to models/MCP tools.
   * Future authenticated UI must verify owner/project/run before invoking it.
   */
  reviewAction(actionId: string, expectedDigest: string, approve: boolean): void {
    this.#ensureReady();
    const record = this.#actions.get(actionId);
    if (!record || record.proposal.effect !== "write" || record.status !== "proposed" || record.proposal.digest !== expectedDigest || typeof approve !== "boolean") throw new BridgeError("review_mismatch");
    this.#checkTarget(record.proposal.target);
    record.status = approve ? "approved" : "rejected";
  }

  actionStatus(actionId: string): ActionStatus | undefined { return this.#actions.get(actionId)?.status; }

  async execute(actionId: string, options: ExecuteOptions = {}): Promise<JsonObject> {
    this.#ensureReady();
    const record = this.#actions.get(actionId);
    if (!record) throw new BridgeError("invalid_input");
    if (record.status === "rejected") throw new BridgeError("write_denied");
    if (record.proposal.effect === "write" && record.status === "proposed") throw new BridgeError("confirmation_required");
    if (record.status !== "proposed" && record.status !== "approved") throw new BridgeError("replay");
    const deadline = this.#deadline(options);
    // Claim before any asynchronous work: concurrent duplicates cannot dispatch.
    record.status = "running";
    let dispatched = false;
    try {
      const action = record.proposal;
      this.#checkTarget(action.target);
      const fresh = await this.#discover(deadline, options.signal);
      this.#checkTarget(action.target);
      if (!fresh.sessions.some((session) => digest(json(session)) === digest(json(this.#session(action.target))))) throw new BridgeError("wrong_studio");
      const capability = fresh.capabilities.find((item) => item.name === action.tool);
      if (!capability || capability.version !== action.version) throw new BridgeError("capability_changed");
      const args = { ...action.input, studio_id: action.target.studioId };
      this.#validateArgs(capability.inputSchema, args);
      await options.beforeDispatch?.();
      // The durable fence may await storage; recheck local binding afterward.
      this.#checkTarget(action.target);
      const result = await this.#request({ method: "tools/call", params: { name: action.tool, arguments: args } }, deadline, options.signal, () => { dispatched = true; });
      if (!object(result) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new BridgeError("protocol_error");
      if (result.isError === true) throw new BridgeError("remote_error");
      record.status = "succeeded";
      return jsonObject(result, MAX_INPUT_BYTES);
    } catch (error) {
      const uncertain = dispatched && record.proposal.effect === "write";
      record.status = uncertain ? "uncertain" : "failed";
      throw new BridgeError(safeError(error).code, uncertain ? "unknown" : dispatched ? "failed" : "not_dispatched");
    }
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#disconnect();
    try { this.#transport.close(); } catch { /* Local waiters have already ended. */ }
  }

  #session(target: StudioTarget): StudioSession {
    const { studioId, name, placeId } = target;
    return { studioId, ...(name === undefined ? {} : { name }), ...(placeId === undefined ? {} : { placeId }) };
  }
  #checkTarget(target: StudioTarget): void {
    if (!this.#selected || digest(json(target)) !== digest(json(this.#selected))) throw new BridgeError("wrong_studio");
  }
  #validateArgs(schema: JsonObject, input: JsonObject): void {
    try { if (this.#validate(jsonObject(schema), jsonObject(input))) return; } catch { /* Fail closed. */ }
    throw new BridgeError("invalid_input");
  }
  #deadline(options: RequestOptions): number {
    return Date.now() + timeout(options.timeoutMs ?? this.#timeout);
  }
  #ensureOpen(): void { if (this.#state === "closed") throw new BridgeError("disconnected"); }
  #ensureReady(): void { this.#ensureOpen(); if (this.#state !== "ready") throw new BridgeError("not_ready"); }
  #send(message: ClientMessage): void {
    this.#ensureOpen();
    try { this.#transport.send(message); } catch { this.close(); throw new BridgeError("disconnected"); }
  }
  #disconnect(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#snapshot = undefined;
    this.#selected = undefined;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(new BridgeError("disconnected")); }
    this.#pending.clear();
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
  }

  #request(body: RequestBody, deadline: number, signal?: AbortSignal, onDispatch?: () => void): Promise<Json> {
    this.#ensureOpen();
    if (signal?.aborted) return Promise.reject(new BridgeError("cancelled"));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new BridgeError("timeout"));
    if (this.#pending.size >= MAX_PENDING || this.#sequence >= MAX_REQUESTS) return Promise.reject(new BridgeError("limit_exceeded"));
    const requestId = `${this.connectionId}:${++this.#sequence}`;
    const message = { ...body, jsonrpc: "2.0", id: requestId } as ClientRequest;
    json(message);
    return new Promise((resolve, reject) => {
      let sent = false;
      const cancel = (code: "cancelled" | "timeout") => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        pending.reject(new BridgeError(code));
        // initialize MUST NOT be cancelled. Close the transport instead.
        if (body.method === "initialize") this.close();
        else if (sent) {
          try { this.#send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: code } }); } catch { /* Best effort. */ }
        }
      };
      const onAbort = () => cancel("cancelled");
      const timer = setTimeout(() => cancel("timeout"), remaining);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      this.#pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        sent = true;
        onDispatch?.();
        this.#send(message);
      } catch (error) {
        this.#pending.delete(requestId);
        cleanup();
        reject(safeError(error));
      }
    });
  }

  #receive(raw: unknown): void {
    if (this.#state === "closed") return;
    let message: JsonObject;
    try { message = jsonObject(raw); } catch { this.close(); return; }
    if (message.jsonrpc !== "2.0") { this.close(); return; }
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "notifications/tools/list_changed") this.#snapshot = undefined;
      return;
    }
    // Unknown, duplicate and late IDs are ignored; generated IDs are never reused.
    if (typeof message.id !== "string") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    pending.cleanup();
    if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error") || Object.hasOwn(message, "method")) pending.reject(new BridgeError("protocol_error"));
    else if (Object.hasOwn(message, "error")) pending.reject(new BridgeError(object(message.error) && Number.isInteger(message.error.code) && typeof message.error.message === "string" ? "remote_error" : "protocol_error"));
    else pending.resolve(message.result);
  }

  async #discover(deadline: number, signal?: AbortSignal): Promise<Discovery> {
    const tools: JsonObject[] = [];
    const seenNames = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 3) throw new BridgeError("limit_exceeded");
      const result = await this.#request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, deadline, signal);
      if (!object(result) || !Array.isArray(result.tools)) throw new BridgeError("discovery_failed");
      for (const tool of result.tools) {
        if (!object(tool) || !toolName(tool.name) || seenNames.has(tool.name)) throw new BridgeError("discovery_failed");
        if (tools.length >= 50) throw new BridgeError("limit_exceeded");
        seenNames.add(tool.name);
        tools.push(tool as JsonObject);
      }
      if (result.nextCursor === undefined) break;
      if (!id(result.nextCursor) || cursors.has(result.nextCursor)) throw new BridgeError("discovery_failed");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    if (!seenNames.has("list_roblox_studios")) throw new BridgeError("capabilities_unavailable");
    const result = await this.#request({ method: "tools/call", params: { name: "list_roblox_studios", arguments: {} } }, deadline, signal);
    if (!object(result) || result.isError === true) throw new BridgeError("discovery_failed");
    let data: unknown = result.structuredContent;
    if (data === undefined && Array.isArray(result.content)) {
      const blocks = result.content.filter((block) => object(block) && block.type === "text" && typeof block.text === "string");
      try { data = JSON.parse(blocks.map((block) => (block as JsonObject).text).join("\n")); } catch { throw new BridgeError("discovery_failed"); }
    }
    const rows = Array.isArray(data) ? data : object(data) ? data.studios : undefined;
    if (!Array.isArray(rows) || rows.length > 30) throw new BridgeError("discovery_failed");
    const sessions: StudioSession[] = [];
    const seenStudios = new Set<string>();
    for (const row of rows) {
      if (!object(row)) throw new BridgeError("discovery_failed");
      const studioId = row.studio_id ?? row.id;
      if (!id(studioId) || seenStudios.has(studioId) || (row.name !== undefined && (typeof row.name !== "string" || row.name.length > 300))) throw new BridgeError("discovery_failed");
      seenStudios.add(studioId);
      const place = row.place_id ?? row.placeId;
      if (place !== undefined && !(typeof place === "string" && /^\d{1,20}$/.test(place)) && !(typeof place === "number" && Number.isSafeInteger(place) && place >= 0)) throw new BridgeError("discovery_failed");
      sessions.push({ studioId, ...(row.name === undefined ? {} : { name: row.name as string }), ...(place === undefined ? {} : { placeId: String(place) }) });
    }
    const capabilities: BridgeCapability[] = [];
    for (const remote of tools) {
      if (!Object.hasOwn(EFFECTS, remote.name as string)) continue;
      const name = remote.name as ActionTool;
      const schema = jsonObject(remote.inputSchema, MAX_SCHEMA_BYTES);
      if (schema.type !== "object" || !object(schema.properties) || !Object.hasOwn(schema.properties, "studio_id")) throw new BridgeError("discovery_failed");
      const effect = EFFECTS[name];
      capabilities.push({ name, scope: "studio", effect, requiresConfirmation: effect === "write", inputSchema: schema, version: digest(json({ connectionId: this.connectionId, name, effect, remote })) });
    }
    return { connectionId: this.connectionId, sessions, capabilities };
  }
}
