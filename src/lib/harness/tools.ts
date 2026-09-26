import { z } from "zod";
import type { Database } from "../history/database.ts";
import { PUBLIC_TOOLS, runPublicTool, type PublicToolName } from "../public-tools.ts";
import type { PublicDataService } from "../public-data.ts";
import { briefSchema, conceptsSchema, idSchema } from "../creative/schema.ts";
import { requireProject } from "../creative/storage.ts";
import { createCreativeWorkflow, saveCreativeConcepts, readCreativeJob } from "../creative/workflow.ts";
import { createUiEntry, updateUiEntry, searchSharedUi, reuseSharedUi, readPrivateUiEntry, exportPrivateUi } from "../ui-library/service.ts";
import { uiLayoutSchema } from "../ui-library/layout.ts";
import { HarnessError } from "./runner.ts";
import type { HarnessTool, ToolContext, ToolEffect } from "./types.ts";

// Caller identity comes from the trusted run, never model-supplied arguments.
// No model tool can grant credits, rights, consent, visual approval or permissions.
export function projectTools(database: Database, service?: PublicDataService): HarnessTool[] {
  const tools: HarnessTool[] = Object.entries(PUBLIC_TOOLS).map(([name, definition]) => ({
    name, description: definition.description, version: "public-1", scope: "public", effect: "read",
    inputSchema: z.toJSONSchema(definition.schema, { target: "draft-7", io: "input" }),
    parse: (input) => definition.schema.parse(input),
    execute: async (input) => (await runPublicTool(name as PublicToolName, input, service)).result,
  }));
  function add<T extends z.ZodType<Record<string, unknown>>>(name: string, description: string, effect: ToolEffect, schema: T, execute: (input: z.output<T>, context: ToolContext) => Promise<unknown>) {
    tools.push({ name, description, version: "project-1", scope: "project", effect, inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }), parse: (input) => schema.parse(input), execute: (input, context) => execute(schema.parse(input), context) });
  }
  async function ui(context: ToolContext, id: string) {
    const entry = await readPrivateUiEntry(database, context.ownerId, id);
    if (entry.project_id !== context.projectId) throw new HarnessError("not_found");
    return entry;
  }
  add("project_context", "Read this project's context.", "read", z.object({}).strict(), async (_, c) => {
    const project = await requireProject(database, c.ownerId, c.projectId);
    return { name: project.name, context: project.context };
  });
  add("project_inventory", "List this project's latest private UI drafts, workflows and image references.", "read", z.object({}).strict(), async (_, c) => {
    await requireProject(database, c.ownerId, c.projectId);
    const params = [c.ownerId, c.projectId];
    const [ui, workflows, assets] = await Promise.all([
      database.query("SELECT id,title,state,revision FROM ui_library_entries WHERE owner_id=$1 AND project_id=$2 AND state <> 'deleted' ORDER BY created_at DESC LIMIT 30", params),
      database.query("SELECT id,kind,credit_budget,approval IS NOT NULL AS reviewed FROM creative_workflows WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 20", params),
      database.query("SELECT id,kind,width,height,metadata->>'label' AS label FROM creative_assets WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 30", params),
    ]);
    return { ui: ui.rows, workflows: workflows.rows, assets: assets.rows };
  });
  add("find_ui", "Search shared, licensed UI before making a new interface.", "read", z.object({ query: z.string().max(100).default(""), tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(6).default([]), limit: z.number().int().min(1).max(30).default(12) }).strict(), (input) => searchSharedUi(database, input));
  add("reuse_ui", "Copy a shared UI into this project as a private draft, preserving attribution.", "write", z.object({ entryId: idSchema }).strict(), (input, c) => reuseSharedUi(database, c.ownerId, c.projectId, input.entryId));
  add("read_ui", "Read one private UI layout in this project.", "read", z.object({ entryId: idSchema }).strict(), async (input, c) => {
    const entry = await ui(c, input.entryId);
    return { id: entry.id, revision: entry.revision, title: entry.title, layout: entry.layout, assets: entry.assets, state: entry.state, license: entry.license, attribution: entry.attribution, credits: entry.credits };
  });
  const draft = z.object({ title: z.string().trim().min(1).max(100), description: z.string().max(500), tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(12), layout: uiLayoutSchema, assets: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/), idSchema) }).strict();
  add("create_ui", "Save a validated, editable UI layout as a private draft.", "write", draft, async (input, c) => {
    const entry = await createUiEntry(database, c.ownerId, c.projectId, input);
    return { id: entry.id, revision: entry.revision, state: entry.state };
  });
  add("update_ui", "Adapt a private UI draft at the revision you inspected.", "write", z.object({ entryId: idSchema, revision: z.number().int().positive(), draft }).strict(), async (input, c) => {
    await ui(c, input.entryId);
    const entry = await updateUiEntry(database, c.ownerId, input.entryId, input.revision, input.draft);
    return { id: entry.id, revision: entry.revision, state: entry.state };
  });
  add("export_ui", "Produce a static Roblox UI snippet using actual Roblox image asset IDs. This does not apply it in Studio.", "read", z.object({ entryId: idSchema, assetIds: z.record(z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)) }).strict(), async (input, c) => {
    await ui(c, input.entryId);
    return exportPrivateUi(database, c.ownerId, input.entryId, input.assetIds);
  });
  add("create_creative_brief", "Save a thumbnail or UI creative brief for concept review. No generation or spending occurs.", "write", z.object({ kind: z.enum(["thumbnail", "ui"]), brief: briefSchema, referenceIds: z.array(idSchema).max(3).default([]), creditBudget: z.number().int().min(1).max(1000) }).strict(), async (input, c) => {
    const result = await createCreativeWorkflow(database, { ...input, ownerId: c.ownerId, projectId: c.projectId, allowAgentReview: false });
    return { id: result.id, kind: result.kind, brief: result.brief };
  });
  add("propose_concepts", "Save up to three written concepts and asset lists. These are not rendered images.", "write", z.object({ workflowId: idSchema, concepts: conceptsSchema }).strict(), async (input, c) => {
    const { rows } = await database.query("SELECT id FROM creative_workflows WHERE id=$1 AND owner_id=$2 AND project_id=$3", [input.workflowId, c.ownerId, c.projectId]);
    if (!rows.length) throw new HarnessError("not_found");
    const result = await saveCreativeConcepts(database, c.ownerId, input.workflowId, input.concepts);
    return { id: result.id, concepts: result.concepts };
  });
  add("read_image_job", "Read an existing image job's actual status.", "read", z.object({ jobId: idSchema }).strict(), async (input, c) => {
    const job = await readCreativeJob(database, c.ownerId, input.jobId);
    if (job.project_id !== c.projectId) throw new HarnessError("not_found");
    return { id: job.id, status: job.status, assetId: job.output_asset_id, error: job.error_code };
  });
  return tools;
}
