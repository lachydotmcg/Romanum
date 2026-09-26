import type { ProjectContext } from "../creative/schema.ts";

export type ToolEffect = "read" | "write" | "execute";
export type ToolScope = "public" | "project" | "studio";
export type ToolContext = { ownerId: string; projectId: string; runId: string; actionId: string; signal: AbortSignal };
export interface HarnessTool {
  name: string;
  description: string;
  version: string;
  scope: ToolScope;
  effect: ToolEffect;
  target?: { studioId: string };
  inputSchema: Record<string, unknown>;
  parse(input: unknown): Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
export type ToolDescriptor = Pick<HarnessTool, "name" | "description" | "version" | "scope" | "effect" | "inputSchema" | "target">;
export type ModelDecision = { kind: "final"; text: string } | { kind: "tool"; tool: string; input: Record<string, unknown>; reason: string };
export interface HarnessModel {
  id: string;
  mode: "test" | "paid";
  next(input: { objective: string; project: ProjectContext; tools: ToolDescriptor[]; observations: unknown[]; instructions: string }, signal: AbortSignal): Promise<unknown>;
}
