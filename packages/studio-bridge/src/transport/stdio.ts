import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import type { BridgeTransport, ClientMessage, JsonObject } from "../protocol.ts";
import type { McpSdk } from "./sdk.ts";
import { createSdkInputValidator } from "./schema.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_QUEUE_BYTES = 512 * 1024;
const MAX_PENDING = 16;
const MAX_REQUESTS = 10_000;
const MAX_NOTIFICATIONS = 20_000;
const TOOLS = new Set(["list_roblox_studios", "get_studio_state", "multi_edit"]);
const REQUEST_SCHEMAS: Record<string, string> = { initialize: "InitializeRequestSchema", "tools/list": "ListToolsRequestSchema", "tools/call": "CallToolRequestSchema", "notifications/initialized": "InitializedNotificationSchema", "notifications/cancelled": "CancelledNotificationSchema" };
const RESULT_SCHEMAS: Record<string, string> = { initialize: "InitializeResultSchema", "tools/list": "ListToolsResultSchema", "tools/call": "CallToolResultSchema" };
const FIXTURE_MODES = ["normal", "malformed-json", "malformed-rpc", "invalid-schema", "unsupported-schema", "unexpected-ids", "crash-read", "crash-write", "timeout-read", "timeout-write", "oversized", "oversized-unframed", "missing-capabilities", "init-timeout", "ignore-eof", "stderr", "split-utf8", "server-requests", "invalid-output", "removed-output"] as const;
export type FixtureMode = typeof FIXTURE_MODES[number];
export type StdioFailure = "transport_disabled" | "invalid_config" | "not_started" | "closed" | "invalid_message" | "invalid_schema" | "queue_limit" | "child_error" | "child_exit" | "startup_timeout" | "shutdown_timeout" | "frame_too_large";
export class StdioTransportError extends Error {
  readonly code: StdioFailure;
  constructor(code: StdioFailure) { super(`Studio transport: ${code}.`); this.name = "StdioTransportError"; this.code = code; }
}
type Request = { method: string; tool?: string; firstToolPage?: boolean; outputSchema?: JsonObject };
type Launch = { command: string; args: string[]; cwd: string };
export interface StdioOptions { startupTimeoutMs?: number }
export interface StdioBridgeTransport extends BridgeTransport {
  readonly failureCode: StdioFailure | undefined;
  readonly pid: number | undefined;
  readonly ignoredResponses: number;
  readonly writesSent: number;
  readonly readsSent: number;
  readonly validateInput: (schema: JsonObject, input: JsonObject) => boolean;
  start(): Promise<void>;
  waitForClose(): Promise<void>;
}
function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000) throw new StdioTransportError("invalid_config");
  return value;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Official MCP stdio framing with stricter malformed-frame handling than the
 * installed SDK transport. Initialization/correlation/approvals stay in StudioBridge.
 * Construct through the fixture or explicitly owner-enabled factories below.
 */
class StdioChannel implements StdioBridgeTransport {
  #launch: Launch;
  #sdk: McpSdk;
  #schemas: ReturnType<typeof createSdkInputValidator>;
  #startupTimeout: number;
  #child: ChildProcessWithoutNullStreams | undefined;
  #state: "new" | "starting" | "open" | "closing" | "closed" = "new";
  #failure: StdioFailure | undefined;
  #listeners = new Set<(message: unknown) => void>();
  #closes = new Set<() => void>();
  #buffer = Buffer.alloc(0);
  #queue: Buffer[] = [];
  #queuedBytes = 0;
  #writing = false;
  #pending = new Map<string, Request>();
  #seen = new Set<string>();
  #notifications = 0;
  #ignoredResponses = 0;
  #writesSent = 0;
  #readsSent = 0;
  #toolSchemas = new Map<string, JsonObject>();
  #outputSchemas = new Map<string, JsonObject>();
  #shutdownTimers: ReturnType<typeof setTimeout>[] = [];
  #closedPromise: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: StdioTransportError) => void;

  /** Launch is trusted application configuration, never serialized model input. */
  constructor(launch: Launch, sdk: McpSdk, options: StdioOptions = {}) {
    this.#launch = { command: launch.command, args: [...launch.args], cwd: launch.cwd };
    this.#sdk = sdk;
    this.#schemas = createSdkInputValidator(sdk);
    this.#startupTimeout = boundedTimeout(options.startupTimeoutMs ?? 3_000);
    this.#closedPromise = new Promise((resolve, reject) => { this.#resolveClosed = resolve; this.#rejectClosed = reject; });
    this.#closedPromise.catch(() => undefined);
  }
  get failureCode(): StdioFailure | undefined { return this.#failure; }
  get pid(): number | undefined { return this.#child?.pid; }
  get ignoredResponses(): number { return this.#ignoredResponses; }
  get writesSent(): number { return this.#writesSent; }
  get readsSent(): number { return this.#readsSent; }
  get validateInput(): (schema: JsonObject, input: JsonObject) => boolean { return this.#schemas.validateInput; }
  onMessage(listener: (message: unknown) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onClose(listener: () => void): () => void { this.#closes.add(listener); return () => this.#closes.delete(listener); }
  waitForClose(): Promise<void> { return this.#closedPromise; }

  async start(): Promise<void> {
    if (this.#state !== "new") throw new StdioTransportError("closed");
    this.#state = "starting";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.#fail("startup_timeout"); reject(new StdioTransportError("startup_timeout")); }, this.#startupTimeout);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.#launch.command, this.#launch.args, { cwd: this.#launch.cwd, env: this.#sdk.environment(), shell: false, windowsHide: true, detached: false, stdio: "pipe" });
      } catch {
        clearTimeout(timer);
        this.#fail("child_error");
        reject(new StdioTransportError("child_error"));
        return;
      }
      this.#child = child;
      child.once("spawn", () => {
        clearTimeout(timer);
        if (this.#state !== "starting") { reject(new StdioTransportError("closed")); return; }
        this.#state = "open";
        resolve();
      });
      child.once("error", () => { clearTimeout(timer); this.#fail("child_error"); reject(new StdioTransportError("child_error")); });
      child.once("exit", () => { clearTimeout(timer); if (this.#state !== "closing") this.#fail("child_exit"); this.#finishClose(); reject(new StdioTransportError("child_exit")); });
      child.once("close", () => { clearTimeout(timer); if (this.#state !== "closing" && this.#state !== "closed") this.#fail("child_exit"); this.#finishClose(); });
      child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
      child.stdout.on("error", () => this.#fail("child_error"));
      child.stdin.on("error", () => this.#fail("child_error"));
      // Drain diagnostics without logging, buffering, forwarding or interpreting them.
      child.stderr.on("data", () => undefined);
      child.stderr.on("error", () => this.#fail("child_error"));
    });
  }

  send(message: ClientMessage): void {
    if (this.#state !== "open") throw new StdioTransportError(this.#state === "new" ? "not_started" : "closed");
    const text = JSON.stringify(message);
    const frame = Buffer.from(text + "\n");
    if (frame.length > MAX_FRAME_BYTES) throw new StdioTransportError("frame_too_large");
    const copy = JSON.parse(text) as ClientMessage;
    if (!this.#valid(REQUEST_SCHEMAS[copy.method], copy)) throw new StdioTransportError("invalid_message");
    if (this.#queuedBytes + frame.length > MAX_QUEUE_BYTES) throw new StdioTransportError("queue_limit");
    if ("id" in copy) {
      if (typeof copy.id !== "string" || copy.id.length > 250 || this.#seen.has(copy.id) || this.#seen.size >= MAX_REQUESTS || this.#pending.size >= MAX_PENDING) throw new StdioTransportError("invalid_message");
      if (copy.method === "tools/call") {
        if (!TOOLS.has(copy.params.name)) throw new StdioTransportError("invalid_message");
        const schema = this.#toolSchemas.get(copy.params.name);
        if (copy.params.name !== "list_roblox_studios" && (!schema || !this.validateInput(schema, copy.params.arguments))) throw new StdioTransportError("invalid_schema");
      }
      this.#seen.add(copy.id);
      const outputSchema = copy.method === "tools/call" ? this.#outputSchemas.get(copy.params.name) : undefined;
      this.#pending.set(copy.id, { method: copy.method, ...(copy.method === "tools/call" ? { tool: copy.params.name } : {}), ...(copy.method === "tools/list" ? { firstToolPage: copy.params.cursor === undefined } : {}), ...(outputSchema ? { outputSchema } : {}) });
      if (copy.method === "tools/call" && copy.params.name === "multi_edit") this.#writesSent++;
      if (copy.method === "tools/call" && copy.params.name === "get_studio_state") this.#readsSent++;
    } else {
      if (++this.#notifications > MAX_NOTIFICATIONS) throw new StdioTransportError("queue_limit");
      if (copy.method === "notifications/cancelled") {
        const request = this.#pending.get(copy.params.requestId);
        if (!request || request.method === "initialize") throw new StdioTransportError("invalid_message");
        this.#pending.delete(copy.params.requestId);
      }
    }
    this.#queue.push(frame);
    this.#queuedBytes += frame.length;
    this.#flush();
  }

  close(): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#state = "closing";
    this.#buffer = Buffer.alloc(0);
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#pending.clear();
    for (const listener of this.#closes) { try { listener(); } catch { /* A subscriber cannot prevent child cleanup. */ } }
    this.#closes.clear();
    this.#listeners.clear();
    const child = this.#child;
    if (!child) { this.#finishClose(); return; }
    try { child.stdin.end(); } catch { /* Continue bounded teardown. */ }
    const kill = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) { try { child.kill(signal); } catch { /* Bound below. */ } }
    };
    this.#shutdownTimers.push(setTimeout(() => kill("SIGTERM"), 100));
    this.#shutdownTimers.push(setTimeout(() => kill("SIGKILL"), 300));
    this.#shutdownTimers.push(setTimeout(() => {
      if (this.#state === "closed") return;
      this.#failure = "shutdown_timeout";
      this.#destroyStreams();
      this.#state = "closed";
      this.#rejectClosed(new StdioTransportError("shutdown_timeout"));
    }, 1_300));
  }

  #valid(schema: string | undefined, value: unknown): boolean {
    try { return !!schema && this.#sdk.schemas[schema].safeParse(value).success; } catch { return false; }
  }
  #flush(): void {
    if (this.#writing || this.#state !== "open" || this.#queue.length === 0) return;
    const frame = this.#queue.shift()!;
    this.#writing = true;
    try {
      this.#child!.stdin.write(frame, (error) => {
        this.#writing = false;
        this.#queuedBytes = Math.max(0, this.#queuedBytes - frame.length);
        if (error) this.#fail("child_error");
        else this.#flush();
      });
    } catch { this.#fail("child_error"); }
  }
  #read(chunk: Buffer): void {
    if (this.#state !== "open") return;
    // Check each frame before copying or parsing, even if one chunk has many frames.
    let offset = 0;
    while (offset < chunk.length && this.#state === "open") {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (this.#buffer.length + end - offset + 1 > MAX_FRAME_BYTES) { this.#fail("frame_too_large"); return; }
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(offset, end)]);
      if (newline === -1) return;
      const frame = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      offset = newline + 1;
      let message: unknown;
      try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); } catch { this.#fail("invalid_message"); return; }
      if (!this.#valid("JSONRPCMessageSchema", message) || !object(message)) { this.#fail("invalid_message"); return; }
      if ("method" in message) {
        // No roots, sampling, elicitation, shell or filesystem requests negotiated.
        if (++this.#notifications > MAX_NOTIFICATIONS) { this.#fail("queue_limit"); return; }
        if ("id" in message) {
          const response = this.#valid("PingRequestSchema", message)
            ? { jsonrpc: "2.0", id: message.id, result: {} }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported" } };
          const reply = Buffer.from(JSON.stringify(response) + "\n");
          if (this.#queuedBytes + reply.length > MAX_QUEUE_BYTES) { this.#fail("queue_limit"); return; }
          this.#queue.push(reply);
          this.#queuedBytes += reply.length;
          this.#flush();
          continue;
        }
        if (message.method === "notifications/tools/list_changed") { this.#toolSchemas.clear(); this.#outputSchemas.clear(); }
        this.#deliver(message);
        continue;
      }
      if (typeof message.id !== "string" || !this.#pending.has(message.id)) { this.#ignoredResponses++; continue; }
      const request = this.#pending.get(message.id)!;
      this.#pending.delete(message.id);
      if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) { this.#fail("invalid_message"); return; }
      if (Object.hasOwn(message, "result")) {
        if (!this.#valid(RESULT_SCHEMAS[request.method], message.result)) { this.#fail("invalid_message"); return; }
        try {
          if (request.method === "tools/list") this.#inspectTools(message.result as JsonObject, request.firstToolPage === true);
          const output = request.outputSchema;
          if (output && object(message.result) && message.result.isError !== true && (!object(message.result.structuredContent) || !this.validateInput(output, message.result.structuredContent as JsonObject))) throw new Error("schema");
        } catch { this.#fail("invalid_schema"); return; }
      }
      this.#deliver(message);
    }
  }
  #inspectTools(result: JsonObject, firstPage: boolean): void {
    if (!Array.isArray(result.tools) || result.tools.length > 50) throw new Error("tools");
    if (firstPage) { this.#toolSchemas.clear(); this.#outputSchemas.clear(); }
    for (const tool of result.tools) {
      if (!object(tool) || (tool.name !== "get_studio_state" && tool.name !== "multi_edit")) continue;
      this.#schemas.inspect(tool.inputSchema);
      this.#toolSchemas.set(tool.name, tool.inputSchema as JsonObject);
      if (tool.outputSchema !== undefined) { this.#schemas.inspect(tool.outputSchema); this.#outputSchemas.set(tool.name, tool.outputSchema as JsonObject); }
    }
  }
  #deliver(message: unknown): void {
    for (const listener of this.#listeners) {
      try { listener(message); } catch { this.#fail("invalid_message"); return; }
    }
  }
  #fail(code: StdioFailure): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#failure = code;
    this.close();
  }
  #destroyStreams(): void { this.#child?.stdin.destroy(); this.#child?.stdout.destroy(); this.#child?.stderr.destroy(); }
  #finishClose(): void {
    if (this.#state === "closed") return;
    for (const timer of this.#shutdownTimers) clearTimeout(timer);
    this.#shutdownTimers = [];
    this.#destroyStreams();
    this.#state = "closed";
    this.#resolveClosed();
  }
}

/** Only the repository-authored fixed fixture can be launched through this path. */
export function createFixtureStdioTransport(sdk: McpSdk, mode: FixtureMode = "normal", options: StdioOptions = {}): StdioBridgeTransport {
  if (!FIXTURE_MODES.includes(mode)) throw new StdioTransportError("invalid_config");
  const script = fileURLToPath(new URL("../../fixtures/stdio-server.mjs", import.meta.url));
  return new StdioChannel({ command: process.execPath, args: [script, "--mode", mode], cwd: path.dirname(script) }, sdk, options);
}

/** Separate trusted owner activation; disabled unless enabled is explicitly true.
 * No command string, extra args, scripts, shell, credentials or model config accepted.
 */
export function createOwnerStdioTransport(config: { enabled?: boolean; executable?: string }, sdk: McpSdk, options: StdioOptions = {}): StdioBridgeTransport {
  if (config.enabled !== true) throw new StdioTransportError("transport_disabled");
  const executable = config.executable;
  const name = process.platform === "win32" ? "StudioMCP.exe" : "StudioMCP";
  try {
    if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== name.toLowerCase()) throw new Error("path");
    const actual = realpathSync(executable);
    if (path.basename(actual).toLowerCase() !== name.toLowerCase() || !statSync(actual).isFile()) throw new Error("path");
    return new StdioChannel({ command: actual, args: [], cwd: path.dirname(actual) }, sdk, options);
  } catch { throw new StdioTransportError("invalid_config"); }
}
