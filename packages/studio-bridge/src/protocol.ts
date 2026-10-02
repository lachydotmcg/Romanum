/** MCP subset exercised by the mock. This is not an additional network protocol. */
export const MCP_VERSION = "2025-11-25";
export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };
export type RpcId = string;

export type ClientRequest =
  | { jsonrpc: "2.0"; id: RpcId; method: "initialize"; params: { protocolVersion: string; capabilities: JsonObject; clientInfo: { name: string; version: string } } }
  | { jsonrpc: "2.0"; id: RpcId; method: "tools/list"; params: { cursor?: string } }
  | { jsonrpc: "2.0"; id: RpcId; method: "tools/call"; params: { name: string; arguments: JsonObject } };
export type ClientNotification =
  | { jsonrpc: "2.0"; method: "notifications/initialized" }
  | { jsonrpc: "2.0"; method: "notifications/cancelled"; params: { requestId: RpcId; reason: "timeout" | "cancelled" } };
export type ClientMessage = ClientRequest | ClientNotification;
export type ServerResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: Json }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string; data?: Json } };

/** Inject an owner-established local channel. No process launch or listener here.
 * send must synchronously enqueue a bounded message or throw, never block.
 * Subscribe before initialize; onClose signals loss of the entire connection.
 */
export interface BridgeTransport {
  send(message: ClientMessage): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export type ActionEffect = "read" | "write";
export type ActionTool = "get_studio_state" | "multi_edit";
export interface StudioSession { studioId: string; name?: string; placeId?: string }
export interface StudioTarget extends StudioSession { connectionId: string; selectionId: string }
export interface BridgeCapability {
  name: ActionTool;
  scope: "studio";
  effect: ActionEffect;
  requiresConfirmation: boolean;
  inputSchema: JsonObject;
  version: string;
}
export interface Discovery {
  connectionId: string;
  sessions: StudioSession[];
  capabilities: BridgeCapability[];
}
export interface ActionProposal {
  actionId: string;
  target: StudioTarget;
  tool: ActionTool;
  effect: ActionEffect;
  version: string;
  input: JsonObject;
  digest: string;
  requiresConfirmation: boolean;
}
export type ActionStatus = "proposed" | "approved" | "rejected" | "running" | "succeeded" | "failed" | "uncertain";
export type DispatchOutcome = "not_dispatched" | "failed" | "unknown";
export type BridgeErrorCode =
  | "disconnected" | "not_ready" | "invalid_input" | "protocol_error"
  | "unsupported_protocol" | "capabilities_unavailable" | "discovery_failed"
  | "wrong_studio" | "unknown_tool" | "capability_changed"
  | "confirmation_required" | "write_denied" | "review_mismatch"
  | "duplicate_action" | "replay" | "timeout" | "cancelled"
  | "remote_error" | "limit_exceeded";

/** Safe error without upstream bodies. A dispatched write error has unknown outcome. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly outcome: DispatchOutcome;
  constructor(code: BridgeErrorCode, outcome: DispatchOutcome = "not_dispatched") {
    super(`Studio bridge: ${code}.`);
    this.name = "BridgeError";
    this.code = code;
    this.outcome = outcome;
  }
}
