import type { Discovery } from "../../../packages/studio-bridge/src/index.ts";
import type { Selection, WorkflowAction, WorkflowCheckpoint, WorkflowRequest } from "../../lib/agent-api-studio-workflow/contracts.ts";

export type StudioSnapshot = { discovery: Discovery; checkpoint: WorkflowCheckpoint; connectionAvailable: boolean };
export interface StudioGateway {
  load(): Promise<StudioSnapshot>;
  send(request: WorkflowRequest): Promise<Selection | WorkflowAction>;
  fixtureScenario?: (scenario: "normal" | "hold" | "uncertain" | "expire") => void;
}
export class StudioClientError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function createPrivateStudioGateway(projectId: string, fetcher: typeof fetch = fetch): StudioGateway {
  const endpoint = `/api/agent-studio/${encodeURIComponent(projectId)}`;
  async function response(request: Promise<Response>) {
    const result = await request;
    const data = await result.json();
    if (!result.ok) throw new StudioClientError(result.status, typeof data.error === "string" ? data.error : "Studio review unavailable.");
    return data;
  }
  return {
    async load() { return response(fetcher(endpoint, { credentials: "same-origin", cache: "no-store" })); },
    async send(request) {
      return (await response(fetcher(endpoint, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }))).result;
    },
  };
}
// Stable request keys survive a UI reload without saving private text or grants.
export function actionRequest(projectId: string, operation: "execute" | "cancel" | "recover", actionId: string): WorkflowRequest {
  return { projectId, operation, actionId, key: `ui:${operation}:${actionId}` };
}
export function reviewRequest(projectId: string, action: WorkflowAction, approve: boolean): WorkflowRequest {
  return { projectId, operation: "review", actionId: action.actionId, digest: action.digest, approve, key: `ui:review:${action.actionId}:${action.digest.slice(0,12)}:${approve ? "yes" : "no"}` };
}
