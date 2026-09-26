import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { HarnessTool, ToolContext, ToolEffect } from "./types.ts";

// Roblox Studio MCP connector.
//
// The connector never trusts the remote server's annotations or descriptions to
// decide what a tool is allowed to do. Effects come from the static allowlist
// below; anything not listed is simply not exposed to the model. Write/execute
// tools still need the harness's approval gate - the connector reports the
// accurate effect and nothing more.
//
// Every exposed tool pins its `studio_id` inside the closure and strips it from
// the model-facing schema, so a model can never choose which Studio session a
// call lands in.

/** Read-only Studio tools the connector exposes. */
const READ_TOOLS = [
  "get_studio_state",
  "search_game_tree",
  "inspect_instance",
  "script_read",
  "script_search",
  "script_grep",
  "get_console_output",
] as const;

/** Write tool the connector exposes. */
const WRITE_TOOLS = ["multi_edit"] as const;

/** Execute tool the connector exposes. */
const EXECUTE_TOOLS = ["execute_luau"] as const;

/** Discovery tool used to enumerate Studio sessions. Never model-facing. */
const DISCOVERY_TOOL = "list_roblox_studios";

/**
 * Authoritative effect map. Effects are decided here, from the tool name, and
 * never from remote annotations.
 */
export const STUDIO_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.freeze({
  ...Object.fromEntries(READ_TOOLS.map((name) => [name, "read" as ToolEffect])),
  ...Object.fromEntries(WRITE_TOOLS.map((name) => [name, "write" as ToolEffect])),
  ...Object.fromEntries(EXECUTE_TOOLS.map((name) => [name, "execute" as ToolEffect])),
});

/** Concise static descriptions. Remote descriptions are never used verbatim. */
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  get_studio_state: "Read the pinned Studio session state.",
  search_game_tree: "Search the pinned Studio session's game tree.",
  inspect_instance: "Inspect one instance in the pinned Studio session.",
  script_read: "Read a script in the pinned Studio session.",
  script_search: "Find scripts in the pinned Studio session.",
  script_grep: "Search text across scripts in the pinned Studio session.",
  get_console_output: "Read the pinned Studio session's console output.",
  multi_edit: "Apply edits to the pinned Studio session.",
  execute_luau: "Run Luau code in the pinned Studio session.",
});

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_PAGES = 3;
const MAX_TOOLS = 50;

const validator = new AjvJsonSchemaValidator();

type StudioErrorCode =
  | "studio_disabled"
  | "invalid_executable"
  | "connect_failed"
  | "connection_closed"
  | "discovery_unavailable"
  | "discovery_failed"
  | "unknown_studio"
  | "unknown_tool"
  | "invalid_input"
  | "input_too_large"
  | "output_too_large"
  | "tool_changed"
  | "tool_error"
  | "list_too_large"
  | "list_duplicate"
  | "cursor_cycle"
  | "timeout"
  | "aborted"
  | "upstream_failed";

/** Safe, code-tagged error. Never carries raw upstream bodies. */
export class StudioConnectorError extends Error {
  readonly code: StudioErrorCode;

  constructor(code: StudioErrorCode, message: string) {
    super(message);
    this.name = "StudioConnectorError";
    this.code = code;
  }
}

/** One discovered Studio session. */
export interface StudioSession {
  id: string;
  name?: string;
}

/** Minimal structural view of the official MCP client used by this connector. */
export interface StudioClientTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

export interface StudioCallOptions {
  signal?: AbortSignal;
  timeout?: number;
  cacheMode?: "refresh";
}

export interface StudioClient {
  listTools(params?: { cursor?: string }, options?: StudioCallOptions): Promise<{ tools: StudioClientTool[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: StudioCallOptions,
  ): Promise<{ isError?: boolean; content?: unknown; structuredContent?: unknown }>;
  close(): Promise<void>;
}

/** Connection returned by {@link connectStudio} and {@link createStudioConnection}. */
export interface StudioConnection {
  listStudios(): Promise<StudioSession[]>;
  tools(studioId: string): Promise<HarnessTool[]>;
  close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedSize(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(text, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function hashVersion(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function describeTool(name: string): string {
  return TOOL_DESCRIPTIONS[name] ?? `Run ${name} in the pinned Studio session.`;
}

/**
 * Deep copy of a remote input schema with `studio_id` removed. Preserve its
 * declared dialect so newer constraints cannot silently disappear.
 * Returns `null` when the schema cannot be safely exposed.
 */
function modelFacingSchema(schema: unknown): Record<string, unknown> | null {
  if (!isPlainObject(schema) || schema.type !== "object") return null;
  const properties = schema.properties;
  if (!isPlainObject(properties) || !Object.prototype.hasOwnProperty.call(properties, "studio_id")) return null;
  let clone: Record<string, unknown>;
  try {
    clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return null;
  }
  delete (clone.properties as Record<string, unknown>).studio_id;
  if (Array.isArray(clone.required)) {
    clone.required = clone.required.filter((key) => key !== "studio_id");
  }
  return clone;
}

/** Version fingerprint: connection identity + studio + name + schema + description. */
function descriptorVersion(identity: string, studioId: string, remote: StudioClientTool): string {
  return hashVersion([
    identity,
    studioId,
    `studio_${remote.name}`,
    remote.description ?? "",
    JSON.stringify(remote.inputSchema),
  ]);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function compileSchema(schema: Record<string, unknown>): ((input: unknown) => boolean) | null {
  try {
    const validate = validator.getValidator(schema);
    return (input: unknown) => validate(input).valid;
  } catch {
    return null;
  }
}

/** Collect text blocks only; images, files and links are ignored, never fetched. */
function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function parseStudioSessions(result: { structuredContent?: unknown; content?: unknown }): StudioSession[] {
  if (serializedSize(result) > MAX_OUTPUT_BYTES) throw new StudioConnectorError("discovery_failed", "The Studio session list was too large.");
  const structured = result.structuredContent;
  const structuredContainers: unknown[] = [];
  if (Array.isArray(structured)) {
    structuredContainers.push(structured);
  } else if (isPlainObject(structured)) {
    structuredContainers.push(structured.studios, structured.studioList);
  }

  let candidates: unknown[] | undefined;
  for (const container of structuredContainers) {
    if (Array.isArray(container)) {
      candidates = container;
      break;
    }
  }

  if (!candidates) {
    const text = collectText(result.content);
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          candidates = parsed;
        } else if (isPlainObject(parsed)) {
          if (Array.isArray(parsed.studios)) candidates = parsed.studios;
          else if (Array.isArray(parsed.studioList)) candidates = parsed.studioList;
        }
      } catch {
        candidates = undefined;
      }
    }
  }

  if (!candidates || candidates.length > 30) throw new StudioConnectorError("discovery_failed", "The Studio session list could not be read.");

  const sessions: StudioSession[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!isPlainObject(item)) throw new StudioConnectorError("discovery_failed", "Invalid Studio session.");
    const id = firstString(item.id, item.studio_id, item.studioId, item.guid, item.sessionId);
    if (!id || id.length > 200 || seen.has(id)) throw new StudioConnectorError("discovery_failed", "Invalid Studio session.");
    seen.add(id);
    const name = firstString(item.name, item.title, item.displayName);
    sessions.push(name ? { id, name: name.slice(0, 300) } : { id });
  }

  if (candidates.length > 0 && sessions.length === 0) {
    throw new StudioConnectorError("discovery_failed", "The Studio session list could not be read.");
  }

  return sessions;
}

function validateExecutable(executable: unknown): string {
  if (typeof executable !== "string" || executable.length === 0 || !path.isAbsolute(executable)) {
    throw new StudioConnectorError("invalid_executable", "The Studio MCP executable path must be absolute.");
  }
  const base = path.basename(executable);
  const windows = process.platform === "win32";
  const expected = windows ? "StudioMCP.exe" : "StudioMCP";
  const matches = windows ? base.toLowerCase() === expected.toLowerCase() : base === expected;
  if (!matches) {
    throw new StudioConnectorError("invalid_executable", `The Studio MCP executable must be named ${expected}.`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(executable);
  } catch {
    throw new StudioConnectorError("invalid_executable", "The Studio MCP executable was not found.");
  }
  if (!stats.isFile()) {
    throw new StudioConnectorError("invalid_executable", "The Studio MCP executable is not a file.");
  }
  return executable;
}

/**
 * Wrap a single client call with a bounded deadline. The caller's signal is
 * linked in, and any upstream failure is replaced by a safe tagged error so raw
 * bodies never reach logs or throws.
 */
async function withDeadline<T>(
  run: (options: StudioCallOptions) => Promise<T>,
  outer: AbortSignal | undefined,
  code: StudioErrorCode = "upstream_failed",
): Promise<T> {
  const controller = new AbortController();
  if (outer?.aborted) throw new StudioConnectorError("aborted", "The Studio call was cancelled.");
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new StudioConnectorError("aborted", "The Studio call ended."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run({ signal: controller.signal, timeout: REQUEST_TIMEOUT_MS }), aborted]);
  } catch {
    if (outer?.aborted) throw new StudioConnectorError("aborted", "The Studio call was cancelled.");
    if (controller.signal.aborted) throw new StudioConnectorError("timeout", "The Studio call timed out.");
    throw new StudioConnectorError(code, "The Studio call failed.");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort!);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Wrap an already-connected MCP client. Structural interface only, so tests can
 * pass a fake client and the official client works unchanged.
 */
export function createStudioConnection(client: StudioClient, options: { identity?: string } = {}): StudioConnection {
  const identity = options.identity ?? randomUUID();
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new StudioConnectorError("connection_closed", "The Studio connection is closed.");
  }

  async function listRawTools(signal?: AbortSignal): Promise<StudioClientTool[]> {
    ensureOpen();
    const tools: StudioClientTool[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) {
        throw new StudioConnectorError("list_too_large", "The Studio tool list exceeded the page limit.");
      }
      const result = await withDeadline(
        (callOptions) => client.listTools(cursor === undefined ? {} : { cursor }, { ...callOptions, cacheMode: "refresh" }),
        signal,
      );
      ensureOpen();
      const pageTools = Array.isArray(result?.tools) ? result.tools : [];
      for (const tool of pageTools) {
        if (!isPlainObject(tool)) continue;
        const name = tool.name;
        if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(name)) throw new StudioConnectorError("unknown_tool", "Invalid Studio tool name.");
        if (seenNames.has(name)) {
          throw new StudioConnectorError("list_duplicate", "The Studio server returned a duplicate tool.");
        }
        if (tools.length >= MAX_TOOLS) {
          throw new StudioConnectorError("list_too_large", "The Studio tool list was too large.");
        }
        seenNames.add(name);
        tools.push(tool as StudioClientTool);
      }
      const next = result?.nextCursor;
      if (typeof next !== "string" || next.length === 0) break;
      if (seenCursors.has(next)) {
        throw new StudioConnectorError("cursor_cycle", "The Studio server repeated a pagination cursor.");
      }
      seenCursors.add(next);
      cursor = next;
    }

    return tools;
  }

  async function listStudiosInternal(rawTools?: StudioClientTool[], signal?: AbortSignal): Promise<StudioSession[]> {
    ensureOpen();
    const tools = rawTools ?? (await listRawTools(signal));
    if (!tools.some((tool) => tool.name === DISCOVERY_TOOL)) {
      throw new StudioConnectorError("discovery_unavailable", "The Studio server did not expose session discovery.");
    }
    const result = await withDeadline(
      (callOptions) => client.callTool({ name: DISCOVERY_TOOL, arguments: {} }, callOptions),
      signal,
      "discovery_failed",
    );
    ensureOpen();
    if (result?.isError) {
      throw new StudioConnectorError("discovery_failed", "The Studio server could not list sessions.");
    }
    return parseStudioSessions(result ?? {});
  }

  function buildTool(remote: StudioClientTool, effect: ToolEffect, studioId: string): HarnessTool | null {
    if (serializedSize(remote.inputSchema) > MAX_SCHEMA_BYTES || (remote.description?.length ?? 0) > 16000) return null;
    const schema = modelFacingSchema(remote.inputSchema);
    if (!schema) return null;
    if (serializedSize(schema) > MAX_SCHEMA_BYTES) return null;
    const validate = compileSchema(schema);
    const validateFull = compileSchema(remote.inputSchema as Record<string, unknown>);
    if (!validate || !validateFull) return null;
    const version = descriptorVersion(identity, studioId, remote);

    const parse = (input: unknown): Record<string, unknown> => {
      if (!isPlainObject(input)) {
        throw new StudioConnectorError("invalid_input", "Tool input must be an object.");
      }
      if (Object.prototype.hasOwnProperty.call(input, "studio_id")) {
        throw new StudioConnectorError("invalid_input", "studio_id is managed by the connector.");
      }
      if (serializedSize(input) > MAX_INPUT_BYTES) {
        throw new StudioConnectorError("input_too_large", "Tool input was too large.");
      }
      if (!validate(input) || !validateFull({ ...input, studio_id: studioId })) {
        throw new StudioConnectorError("invalid_input", "Tool input did not match the Studio schema.");
      }
      return input;
    };

    return {
      name: `studio_${remote.name}`,
      description: describeTool(remote.name),
      version,
      scope: "studio",
      effect,
      target: { studioId },
      inputSchema: schema,
      parse,
      async execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
        ensureOpen();
        if (context?.signal?.aborted) {
          throw new StudioConnectorError("aborted", "The Studio call was cancelled.");
        }

        // Validate model input (and reject any model-supplied studio_id) before
        // anything reaches the server.
        const validated = parse(input);

        // Refresh metadata before every call and fail closed if anything moved.
        const freshTools = await listRawTools(context.signal);
        const fresh = freshTools.find((tool) => tool.name === remote.name);
        if (!fresh || STUDIO_TOOL_EFFECTS[fresh.name] !== effect) {
          throw new StudioConnectorError("unknown_tool", "The Studio tool is no longer available.");
        }
        const freshSchema = modelFacingSchema(fresh.inputSchema);
        if (!freshSchema || descriptorVersion(identity, studioId, fresh) !== version) {
          throw new StudioConnectorError("tool_changed", "The Studio tool changed since it was listed.");
        }

        const studios = await listStudiosInternal(freshTools, context.signal);
        if (!studios.some((session) => session.id === studioId)) {
          throw new StudioConnectorError("unknown_studio", "The pinned Studio session is no longer available.");
        }

        const args: Record<string, unknown> = { ...validated, studio_id: studioId };
        const result = await withDeadline(
          (callOptions) => client.callTool({ name: remote.name, arguments: args }, callOptions),
          context?.signal,
        );
        if (result?.isError) {
          throw new StudioConnectorError("tool_error", "The Studio tool reported an error.");
        }

        const text = collectText(result?.content);
        const structured = result?.structuredContent ?? null;
        const output = { structuredContent: structured, text };
        if (serializedSize(output) > MAX_OUTPUT_BYTES) {
          throw new StudioConnectorError("output_too_large", "The Studio tool output was too large.");
        }
        return output;
      },
    };
  }

  return {
    async listStudios(): Promise<StudioSession[]> {
      ensureOpen();
      return listStudiosInternal();
    },
    async tools(studioId: string): Promise<HarnessTool[]> {
      ensureOpen();
      if (typeof studioId !== "string" || studioId.length === 0 || studioId.length > 200) {
        throw new StudioConnectorError("unknown_studio", "A Studio session id is required.");
      }
      const rawTools = await listRawTools();
      const studios = await listStudiosInternal(rawTools);
      if (!studios.some((session) => session.id === studioId)) {
        throw new StudioConnectorError("unknown_studio", "The requested Studio session is not available.");
      }
      const exposed: HarnessTool[] = [];
      for (const remote of rawTools) {
        const effect = Object.hasOwn(STUDIO_TOOL_EFFECTS, remote.name) ? STUDIO_TOOL_EFFECTS[remote.name] : undefined;
        if (!effect) continue;
        const tool = buildTool(remote, effect, studioId);
        if (tool) exposed.push(tool);
      }
      return exposed;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const closing = client.close().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([closing, new Promise((resolve) => { timer = setTimeout(resolve, 5_000); })]); }
      finally { clearTimeout(timer!); }
    },
  };
}

/**
 * Launch the official local Studio MCP server over stdio and return a pinned
 * connection. The executable path is chosen by the owner or CLI caller, never
 * by a model.
 */
export async function connectStudio(executable: string, enabled: boolean): Promise<StudioConnection> {
  if (enabled !== true) {
    throw new StudioConnectorError("studio_disabled", "The Roblox Studio connector is disabled.");
  }
  const command = validateExecutable(executable);

  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/client/stdio");

  const transport = new StdioClientTransport({
    command,
    args: [],
    env: getDefaultEnvironment(),
    stderr: "ignore",
    maxBufferSize: MAX_BUFFER_BYTES,
  });
  const client = new Client({ name: "romanum-studio", version: "0.1.0" });

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch {
    try {
      await client.close();
    } catch {
      // Ignore teardown failures; we are already failing closed.
    }
    throw new StudioConnectorError("connect_failed", "Could not start the Roblox Studio MCP server.");
  }

  const connection = createStudioConnection(client as unknown as StudioClient, { identity: randomUUID() });
  try {
    await connection.listStudios();
  } catch {
    await connection.close();
    throw new StudioConnectorError("connect_failed", "The Roblox Studio MCP server did not respond to discovery.");
  }
  return connection;
}
