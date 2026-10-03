import { z } from "zod";
import type { ActionProposal, JsonObject, StudioTarget } from "../../../packages/studio-bridge/src/index.ts";
import { idSchema } from "../creative/schema.ts";

const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const common = { projectId: idSchema, key };
export const editInput = z.object({
  datamodel_type: z.literal("Edit"),
  edits: z.array(z.object({
    path: z.string().min(1).max(300), oldText: z.string().max(4000), newText: z.string().max(4000),
  }).strict()).min(1).max(10),
}).strict();
export const workflowRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("select"), ...common, studioId: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal("inspect"), ...common, selectionId: idSchema }).strict(),
  z.object({ operation: z.literal("propose"), ...common, inspectionId: idSchema, input: editInput }).strict(),
  z.object({ operation: z.literal("review"), ...common, actionId: idSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), approve: z.boolean() }).strict(),
  z.object({ operation: z.literal("execute"), ...common, actionId: idSchema }).strict(),
  z.object({ operation: z.literal("cancel"), ...common, actionId: idSchema }).strict(),
  z.object({ operation: z.literal("recover"), ...common, actionId: idSchema }).strict(),
]);
export type WorkflowRequest = z.infer<typeof workflowRequest>;
export type WorkflowStatus = "proposed" | "approved" | "rejected" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain";
export type Selection = { selectionId: string; target: StudioTarget };
export type WorkflowAction = {
  actionId: string; selectionId: string; inspectionId: string | null;
  proposal: ActionProposal; digest: string; status: WorkflowStatus;
  dispatchPhase: "pending" | "dispatching"; result: JsonObject | null;
  errorCode: string | null; expiresAt: string;
  leaseExpiresAt: string | null; recoverable: boolean;
};
export type WorkflowCheckpoint = { actions: WorkflowAction[]; selection: Selection | null; requiresSelection: boolean };
export class StudioWorkflowError extends Error {
  readonly code: "invalid" | "not_found" | "conflict" | "stale_selection" | "approval_expired" | "unavailable" | "limit";
  constructor(code: StudioWorkflowError["code"]) {
    super(`Studio workflow: ${code}.`); this.name = "StudioWorkflowError"; this.code = code;
  }
}
