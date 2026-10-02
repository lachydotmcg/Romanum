import { randomUUID } from "node:crypto";
import { CreativeError } from "../creative/storage.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import type { Database } from "../history/database.ts";
import { cancelAgentRun, createAgentRun, HarnessError, readAgentRun, runAgentToCheckpoint } from "../harness/runner.ts";
import type { HarnessModel, HarnessTool } from "../harness/types.ts";
import { agentJobRequestSchema, type AgentJobEvent, type AgentJobResult, type LocalAgentApi } from "./contracts.ts";

export type LocalAgentApiOptions = {
  database: Database;
  // Supply an already established trusted identity. Requests cannot choose it.
  ownerId: string;
  model: HarnessModel;
  tools: HarnessTool[];
  enabled?: boolean;
};
type StoredRun = Awaited<ReturnType<typeof readAgentRun>>;
type EventDetail = AgentJobEvent extends infer Event
  ? Event extends AgentJobEvent ? Omit<Event, "version" | "executionId" | "jobId" | "sequence"> : never
  : never;

function jobResult(run: StoredRun): AgentJobResult {
  // Deliberately project fields: no identity, context, claims, approval digests,
  // tool inputs/results or provider payloads cross this boundary.
  return {
    version: 1, jobId: run.id, projectId: run.project_id, status: run.status,
    steps: run.steps, maxSteps: run.max_steps, output: run.final_text,
    waitingForJobId: run.waiting_job_id, errorCode: run.error_code,
    actions: run.actions.map(action => ({
      actionId: action.id, sequence: action.sequence, tool: action.tool_name,
      scope: action.tool_scope, effect: action.effect, status: action.status,
      errorCode: action.error_code,
    })),
  };
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HarnessError) throw error;
    if (error instanceof CreativeError && error.code === "not_found") throw new HarnessError("not_found");
    // Infrastructure failures must not expose connection or upstream details.
    throw new HarnessError("unavailable");
  }
}

export function createLocalAgentApi(options: LocalAgentApiOptions): LocalAgentApi {
  const { database, model } = options;
  const ownerId = ownerIdSchema.parse(options.ownerId);
  const tools = [...options.tools];
  const names = new Set(tools.map(tool => tool.name));
  const enabled = options.enabled === true;
  function available() {
    if (!enabled || model.mode !== "test") throw new HarnessError("unavailable");
  }
  function id(value: string) {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) throw new HarnessError("invalid");
    return parsed.data;
  }
  const read = (jobId: string) => readAgentRun(database, ownerId, jobId);

  return {
    async create(request) {
      available();
      const parsed = agentJobRequestSchema.safeParse(request);
      if (!parsed.success || parsed.data.allowedTools.some(name => !names.has(name))) throw new HarnessError("invalid");
      const data = parsed.data;
      // This facade never delegates project writes. Approval remains the
      // existing separate, trusted, exact-action review operation.
      return safe(async () => jobResult(await createAgentRun(database, {
        ownerId, projectId: data.projectId, objective: data.objective,
        allowedTools: data.allowedTools, maxSteps: data.maxSteps, autoProjectWrites: false,
      })));
    },
    async read(jobId) {
      available();
      const runId = id(jobId);
      return safe(async () => jobResult(await read(runId)));
    },
    async cancel(jobId) {
      available();
      const runId = id(jobId);
      return safe(async () => {
        await cancelAgentRun(database, ownerId, runId);
        return jobResult(await read(runId));
      });
    },
    async run(jobId, { signal } = {}) {
      available();
      const runId = id(jobId);
      return safe(async () => {
        const initial = await read(runId);
        // Do not adopt a run created elsewhere with broader write delegation.
        if (initial.auto_project_writes || initial.allowed_tools.some(name => !names.has(name))) throw new HarnessError("invalid");
        const executionId = randomUUID();
        const events: AgentJobEvent[] = [];
        let active = true;
        const emit = (detail: EventDetail) => {
          if (active) events.push({ ...detail, version: 1, executionId, jobId: runId, sequence: events.length + 1 });
        };
        emit({ type: "job.started", status: initial.status });
        const tracedModel: HarnessModel = {
          id: model.id, mode: model.mode,
          async next(input, modelSignal) {
            emit({ type: "model.started", model: model.id });
            try {
              const result = await model.next(input, modelSignal);
              if (!modelSignal.aborted) emit({ type: "model.returned", model: model.id });
              return result;
            } catch (error) {
              emit({ type: "model.failed", model: model.id, errorCode: modelSignal.aborted ? "aborted" : "adapter_failed" });
              throw error;
            }
          },
        };
        const tracedTools = tools.map((tool): HarnessTool => ({
          ...tool,
          parse: input => tool.parse(input),
          async execute(input, context) {
            const detail = { tool: tool.name, actionId: context.actionId };
            emit({ type: "tool.started", ...detail });
            try {
              const result = await tool.execute(input, context);
              if (!context.signal.aborted) emit({ type: "tool.returned", ...detail });
              return result;
            } catch (error) {
              emit({ type: "tool.failed", ...detail, errorCode: context.signal.aborted ? "aborted" : "adapter_failed" });
              throw error;
            }
          },
        }));
        let cancellation: Promise<unknown> | undefined;
        let cancellationFailed = false;
        const abort = () => {
          // Commit cancellation before the runner aborts its local operation.
          // Catch immediately so an asynchronous DB error cannot go unhandled.
          cancellation ??= cancelAgentRun(database, ownerId, runId).catch(() => { cancellationFailed = true; });
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        try {
          if (cancellation) await cancellation;
          else await runAgentToCheckpoint(database, tracedModel, tracedTools, ownerId, runId);
          let current = await read(runId);
          // Abort may arrive during the final read as well as during execution.
          if (cancellation) {
            await cancellation;
            current = await read(runId);
          }
          if (cancellationFailed) throw new HarnessError("unavailable");
          const job = jobResult(current);
          emit({ type: "job.checkpoint", status: job.status, steps: job.steps, errorCode: job.errorCode });
          return { job, events };
        } finally {
          active = false; // Suppress late events from an adapter ignoring abort.
          signal?.removeEventListener("abort", abort);
        }
      });
    },
  };
}
