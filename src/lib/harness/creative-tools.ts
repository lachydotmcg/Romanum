import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../history/database.ts";
import type { ImageProvider } from "../creative/image-provider.ts";
import { reviewCreativeConcept, type ConceptReviewer } from "../creative/review.ts";
import { briefSchema, conceptsSchema, idSchema } from "../creative/schema.ts";
import { CreativeError } from "../creative/storage.ts";
import { cancelCreativeJob, createCreativeWorkflow, queueCreativeJob, readCreativeJob, readCreativeWorkflow, saveCreativeConcepts } from "../creative/workflow.ts";
import type { HarnessTool, ToolContext, ToolEffect } from "./types.ts";

// Trusted composition only. These options are never model arguments or public
// MCP inputs. A future authenticated session must supply the owner's delegation.
export type CreativeToolsOptions = {
  provider?: ImageProvider;
  reviewer?: ConceptReviewer;
  allowAgentReview?: boolean;
  maxWorkflowCredits?: number;
};

export function creativeTools(database: Database, options: CreativeToolsOptions = {}): HarnessTool[] {
  const provider = options.provider, reviewer = options.reviewer;
  const allowAgentReview = options.allowAgentReview === true;
  const maxWorkflowCredits = z.number().int().min(1).max(1000).parse(options.maxWorkflowCredits ?? 1000);
  const identity = () => JSON.stringify({
    maxWorkflowCredits, allowAgentReview,
    provider: provider ? [provider.id, provider.model, provider.mode, provider.available] : null,
    reviewer: reviewer ? [reviewer.id, reviewer.model, reviewer.mode, reviewer.available] : null,
  });
  const snapshot = identity();
  const version = `creative-1-${createHash("sha256").update(snapshot).digest("hex")}`;
  const tools: HarnessTool[] = [];
  function add<T extends z.ZodType<Record<string, unknown>>>(name: string, description: string, effect: ToolEffect, schema: T, execute: (input: z.output<T>, context: ToolContext) => Promise<unknown>) {
    tools.push({ name, description, version, scope: "project", effect,
      inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }), parse: (input) => schema.parse(input),
      execute: async (input, c) => {
        if (c.signal.aborted || identity() !== snapshot) throw new CreativeError("unavailable");
        return execute(schema.parse(input), c);
      },
    });
  }
  async function flow(c: ToolContext, id: string) {
    const result = await readCreativeWorkflow(database, c.ownerId, id);
    if (result.project_id !== c.projectId) throw new CreativeError("not_found");
    return result;
  }
  async function job(c: ToolContext, id: string) {
    const result = await readCreativeJob(database, c.ownerId, id);
    if (result.project_id !== c.projectId) throw new CreativeError("not_found");
    return result;
  }
  const jobSummary = (item: Awaited<ReturnType<typeof readCreativeJob>>) => ({
    id: item.id, workflowId: item.workflow_id, conceptKey: item.concept_key, stage: item.stage,
    assetKey: item.asset_key, status: item.status, assetId: item.output_asset_id, error: item.error_code,
  });
  add("create_creative_brief", "Save a thumbnail or UI brief. No generation occurs; the credit budget caps this workflow's test jobs.", "write", z.object({
    kind: z.enum(["thumbnail", "ui"]), brief: briefSchema, referenceIds: z.array(idSchema).max(3).default([]),
    creditBudget: z.number().int().min(1).max(maxWorkflowCredits),
  }).strict(), async (input, c) => {
    const result = await createCreativeWorkflow(database, { ...input, ownerId: c.ownerId, projectId: c.projectId, allowAgentReview });
    return { id: result.id, kind: result.kind, brief: result.brief, agentReviewAllowed: result.allow_agent_review };
  });
  add("propose_concepts", "Save up to three written concepts and asset lists. These are not rendered images.", "write", z.object({ workflowId: idSchema, concepts: conceptsSchema }).strict(), async (input, c) => {
    await flow(c, input.workflowId);
    const result = await saveCreativeConcepts(database, c.ownerId, input.workflowId, input.concepts);
    return { id: result.id, concepts: result.concepts };
  });
  add("read_creative_workflow", "Read a project's actual concepts, visual review and image-job status. Asset IDs are private references, not public URLs.", "read", z.object({ workflowId: idSchema }).strict(), async (input, c) => {
    const result = await flow(c, input.workflowId);
    return { id: result.id, kind: result.kind, brief: result.brief, concepts: result.concepts, phase: result.phase,
      creditBudget: result.credit_budget, agentReviewAllowed: result.allow_agent_review, approval: result.approval,
      jobs: result.jobs.map(jobSummary) };
  });
  add("read_image_job", "Read an existing image job's actual status.", "read", z.object({ jobId: idSchema }).strict(), async (input, c) => jobSummary(await job(c, input.jobId)));
  add("cancel_image_job", "Cancel a queued image job and release its test-credit hold. Running or uncertain work cannot be cancelled here.", "write", z.object({ jobId: idSchema }).strict(), async (input, c) => {
    await job(c, input.jobId);
    if (c.signal.aborted) throw new CreativeError("unavailable");
    return jobSummary(await cancelCreativeJob(database, c.ownerId, input.jobId));
  });
  // Rendering belongs to a separate worker, not the agent's short tool deadline.
  // No worker is implicitly launched and queued does not mean generated.
  if (provider?.mode === "test" && provider.available) {
    add("queue_image", "Queue a test image job. A separate worker must render it. Finals and separate UI assets need an approved concept render first; check status before continuing.", "write", z.object({
      workflowId: idSchema, conceptKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
      stage: z.enum(["concept", "final", "asset"]), assetKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(),
    }).strict(), async (input, c) => {
      const current = await flow(c, input.workflowId);
      if (current.credit_budget > maxWorkflowCredits) throw new CreativeError("budget_exceeded");
      if (c.signal.aborted) throw new CreativeError("unavailable");
      return jobSummary(await queueCreativeJob(database, provider, { ...input, ownerId: c.ownerId, jobId: c.actionId }));
    });
  }
  if (allowAgentReview && reviewer?.mode === "test" && reviewer.available) {
    add("review_concept", "Ask the configured visual reviewer to inspect a successful concept image. Only an existing owner delegation permits approval. The reviewer receives actual stored pixels; the agent cannot supply its verdict.", "write", z.object({ workflowId: idSchema, jobId: idSchema }).strict(), async (input, c) =>
      reviewCreativeConcept(database, reviewer, { ...input, ownerId: c.ownerId, projectId: c.projectId, reviewId: c.actionId }, c.signal));
  }
  return tools;
}
