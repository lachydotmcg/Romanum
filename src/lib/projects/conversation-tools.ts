import { z } from "zod";
import type { Database } from "../history/database.ts";
import type { ChatProject } from "./chat-context.ts";
import { projectInputSchema } from "./store.ts";
import { projectChatTools, type ProjectChatTools } from "./chat-tools.ts";
import { ConversationContextError, saveChatProjectContext } from "./conversation-context.ts";

const schema = projectInputSchema.extend({ expectedRevision: z.number().int().min(0) }).strict();

/** This factory is supplied only to authenticated saved chats, never public MCP or Ask Romanum. */
export function conversationTools(db: Database, scope: { ownerId: string; chatId: string; questionId: string; project: ChatProject | null }, signal: AbortSignal): ProjectChatTools {
  let project = scope.project;
  const assets = () => project ? projectChatTools(db, { ...scope, projectId: project.id, projectRevision: project.revision, archived: project.archived }, signal) : null;
  let assetTools = assets();
  let saves = 0;
  let assetSaves = 0;
  return {
    get definitions() {
      return [
        ...(!project?.archived ? [{ type: "function" as const, function: {
          name: "save_project_context",
          description: "Save or update the game plan discussed in THIS chat. Use after the user asks to plan/save/develop their game or agrees to the proposed direction; do not turn unrelated questions or brainstorming alternatives into a project. Save agreed decisions, leave unknown fields empty, and label proposals in the plan. Preserve existing decisions, roadmap and todo completion unless the user changes them. Include a concise written plan, ordered roadmap and actionable todos when discussed. Use expectedRevision 0 before a project exists, otherwise the current saved revision. This creates the project around the existing conversation; it never starts generation, spending or development jobs. Save at most once per message. Return the actual saved result before claiming success.",
          parameters: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
        } }] : []),
        ...(assetTools?.definitions ?? []),
      ];
    },
    async execute(call, callId) {
      if (signal.aborted) return { ok: false, error: "Stopped." };
      if (call.name !== "save_project_context") {
        if (call.name === "save_asset_plan" && ++assetSaves > 3) return { ok: false, error: "Save up to three asset plans per message." };
        return assetTools ? assetTools.execute(call, callId) : { ok: false, error: "Save the project context first." };
      }
      if (project?.archived) return { ok: false, error: "Restore this project before changing its context." };
      const input = schema.safeParse(call.args);
      if (!input.success) return { ok: false, error: "Check the project name, context and revision." };
      if (++saves > 1) return { ok: false, error: "Save the context once per message. Continue in a new message for further changes." };
      try {
        const saved = await saveChatProjectContext(db, { ownerId: scope.ownerId, chatId: scope.chatId, questionId: scope.questionId, ...input.data });
        project = saved; assetTools = assets();
        return { ok: true, result: { saved: true, project: saved }, summary: "Project context saved", project: saved };
      } catch (error) {
        if (error instanceof ConversationContextError) {
          if (error.code === "conflict") return { ok: false, error: "The conversation or project changed. Continue in a new message with the latest context." };
          if (error.code === "limit") return { ok: false, error: "You've reached the project limit." };
          if (error.code === "not_found") return { ok: false, error: "Chat or account unavailable." };
          return { ok: false, error: "Check the project details." };
        }
        return { ok: false, error: "Couldn't save the project context. Try again later." };
      }
    },
  };
}
