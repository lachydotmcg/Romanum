import { z } from "zod";
import { idSchema } from "../creative/schema.ts";
import type { readAgentRun } from "../harness/runner.ts";

export const agentJobRequestSchema = z.object({
  version: z.literal(1),
  projectId: idSchema,
  objective: z.string().trim().min(1).max(4000),
  allowedTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(64)
    .refine(names => new Set(names).size === names.length, "Tool names must be unique."),
  maxSteps: z.number().int().min(1).max(20).default(12),
}).strict();

export type AgentJobRequest = z.input<typeof agentJobRequestSchema>;
type StoredRun = Awaited<ReturnType<typeof readAgentRun>>;
export type AgentJobStatus = StoredRun["status"];
export type AgentActionSummary = {
  actionId: string;
  sequence: number;
  tool: string;
  scope: StoredRun["actions"][number]["tool_scope"];
  effect: StoredRun["actions"][number]["effect"];
  status: StoredRun["actions"][number]["status"];
  errorCode: string | null;
};
export type AgentJobResult = {
  version: 1;
  jobId: string;
  projectId: string;
  status: AgentJobStatus;
  steps: number;
  maxSteps: number;
  output: string | null;
  waitingForJobId: string | null;
  errorCode: string | null;
  actions: AgentActionSummary[];
};

// A trace of this invocation, not a durable event log. Adapter return events do
// not imply validation, approval or persistence; the checkpoint reports that.
export type AgentJobEvent = {
  version: 1;
  executionId: string;
  jobId: string;
  sequence: number;
} & (
  | { type: "job.started"; status: AgentJobStatus }
  | { type: "model.started" | "model.returned"; model: string }
  | { type: "model.failed"; model: string; errorCode: "adapter_failed" | "aborted" }
  | { type: "tool.started" | "tool.returned"; tool: string; actionId: string }
  | { type: "tool.failed"; tool: string; actionId: string; errorCode: "adapter_failed" | "aborted" }
  | { type: "job.checkpoint"; status: AgentJobStatus; steps: number; errorCode: string | null }
);
export type AgentJobExecution = { job: AgentJobResult; events: AgentJobEvent[] };
export interface LocalAgentApi {
  create(request: AgentJobRequest): Promise<AgentJobResult>;
  read(jobId: string): Promise<AgentJobResult>;
  run(jobId: string, options?: { signal?: AbortSignal }): Promise<AgentJobExecution>;
  cancel(jobId: string): Promise<AgentJobResult>;
}
