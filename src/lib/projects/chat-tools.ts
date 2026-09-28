import { createHash } from "node:crypto";
import { z } from "zod";
import type OpenAI from "openai";
import type { Database } from "../history/database.ts";
import type { ToolCall, ToolOutcome } from "../assistant/tools.ts";
import { createProjectPlan, listProjectPlans, readProjectPlan, planInputSchema, PlanError } from "./plans.ts";

export type ProjectChatTools = {
  definitions: OpenAI.Chat.ChatCompletionFunctionTool[];
  execute: (call: ToolCall, callId: string) => Promise<ToolOutcome>;
};
const schemas = {
  save_asset_plan: planInputSchema,
  list_asset_plans: z.object({}).strict(),
  read_asset_plan: z.object({ planId: z.uuid() }).strict(),
};
const descriptions = {
  save_asset_plan: "Save a private written thumbnail or UI plan in this chat's project. Provide 1–3 original concepts with composition prompts and a clearly labelled creative hypothesis. UI concepts need an asset breakdown; thumbnail concepts must not have assets. Use the project's actual gameplay promise. This saves text only: it does not generate images, grant approval, queue work, or authorise spending. Use when the user asks to plan/design a thumbnail or UI, or to save a proposed plan. Load a relevant skill first. Never claim measured CTR or invent reference performance.",
  list_asset_plans: "List this project's previously saved written asset plans, including their IDs and titles.",
  read_asset_plan: "Read a saved written asset plan from this project. Use before discussing or revising a previous plan. Revisions should be saved as a new plan, keeping the old one intact.",
};

/** Only the authenticated chat route can supply this scope; it never comes from model arguments. */
export function projectChatTools(database: Database, scope: { ownerId: string; projectId: string; chatId: string; questionId: string; projectRevision: number; archived: boolean }, signal: AbortSignal): ProjectChatTools {
  const names = Object.keys(schemas) as (keyof typeof schemas)[];
  const allowed = names.filter((name) => !scope.archived || name !== "save_asset_plan");
  let saveAttempts = 0;
  return {
    definitions: allowed.map((name) => ({ type: "function", function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { target: "draft-7", io: "input" }) } })),
    async execute(call, callId) {
      if (signal.aborted) return { ok: false, error: "Stopped." };
      const name = call.name as keyof typeof schemas;
      if (!allowed.includes(name)) return { ok: false, error: "Unknown project tool." };
      const parsed = schemas[name].safeParse(call.args);
      if (!parsed.success) return { ok: false, error: name === "save_asset_plan" ? "Check the plan details. UI concepts need assets; thumbnails do not." : "Invalid plan lookup." };
      try {
        if (name === "list_asset_plans") {
          const plans = await listProjectPlans(database, scope.ownerId, scope.projectId);
          return { ok: true, result: { plans }, summary: `${plans.length} saved plans` };
        }
        if (name === "read_asset_plan") {
          const plan = await readProjectPlan(database, scope.ownerId, scope.projectId, (parsed.data as { planId: string }).planId);
          return plan ? { ok: true, result: { plan }, summary: plan.title } : { ok: false, error: "Plan not found in this project." };
        }
        if (!callId || callId.length > 200 || ++saveAttempts > 3) return { ok: false, error: "Save up to three plans per message." };
        // Provider call IDs need not be unique across questions. Scope retries to this saved question.
        const operation = createHash("sha256").update(`${scope.questionId}\0${callId}`).digest("hex");
        const plan = await createProjectPlan(database, { ownerId: scope.ownerId, projectId: scope.projectId, chatId: scope.chatId, callId: operation, projectRevision: scope.projectRevision, input: parsed.data });
        const summary = { id: plan.id, projectId: plan.projectId, title: plan.title, kind: plan.kind, conceptCount: plan.concepts.length };
        return { ok: true, result: { saved: true, ...summary, format: "written_plan", generationStarted: false }, summary: "Written plan saved", plan: summary };
      } catch (error) {
        if (error instanceof PlanError) {
          if (error.code === "not_found") return { ok: false, error: "Project or chat not found." };
          if (error.code === "conflict") return { ok: false, error: "The brief changed or the project was archived. Start a new message before saving another plan." };
          if (error.code === "limit") return { ok: false, error: "This project has reached its saved-plan limit." };
          return { ok: false, error: "Invalid plan details." };
        }
        return { ok: false, error: "Plans unavailable. Try again later." };
      }
    },
  };
}
