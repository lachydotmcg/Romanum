import { z } from "zod";
import type { HarnessModel, HarnessTool, ModelDecision } from "../harness/types.ts";

type ModelInput = Parameters<HarnessModel["next"]>[0];
export type MockModelStep = ModelDecision | ((input: ModelInput, signal: AbortSignal) => unknown | Promise<unknown>);

// Finite scripts only; no provider SDK, environment variables or network calls.
export function createScriptedModel(steps: readonly MockModelStep[]): HarnessModel {
  const script = [...steps];
  let index = 0;
  return {
    id: "mock-script", mode: "test",
    async next(input, signal) {
      signal.throwIfAborted();
      if (index >= script.length) throw new Error("Mock script exhausted.");
      const step = script[index++];
      return typeof step === "function" ? step(input, signal) : structuredClone(step);
    },
  };
}

export function createMockTool(options: {
  name: string;
  schema: z.ZodType<Record<string, unknown>>;
  execute: HarnessTool["execute"];
  scope?: HarnessTool["scope"];
  effect?: HarnessTool["effect"];
  target?: HarnessTool["target"];
}): HarnessTool {
  return {
    name: options.name, description: `Local fixture: ${options.name}`, version: "mock-1",
    scope: options.scope ?? "project", effect: options.effect ?? "read",
    ...(options.target ? { target: options.target } : {}),
    inputSchema: z.toJSONSchema(options.schema),
    parse: input => options.schema.parse(input),
    async execute(input, context) {
      context.signal.throwIfAborted();
      return options.execute(input, context);
    },
  };
}
