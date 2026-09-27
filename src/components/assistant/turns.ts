import type { ChartSpec } from "@/lib/charts/spec";
import type { AssistantEvent } from "@/lib/assistant/types";

export type Step =
  | { kind: "thinking"; id: string; text: string; startedAt: number; endedAt: number | null }
  | {
      kind: "tool";
      id: string;
      label: string;
      activity: string;
      detail: string;
      input: unknown;
      status: "running" | "done" | "error";
      summary?: string;
      result?: unknown;
      ms?: number;
      startedAt: number;
      endedAt: number | null;
    }
  /** A short line the model wrote between steps, like "I'll look that up". */
  | { kind: "note"; id: string; text: string };

/** One question and everything the assistant did to answer it. */
export type Turn = {
  id: string;
  question: string;
  /** Reference images sent with the question, in chats. */
  attachments?: { id: string; name: string; url: string }[];
  steps: Step[];
  charts: { id: string; chart: ChartSpec }[];
  answer: string[];
  /** Text still streaming: it becomes a note if more steps follow, or part of the answer. */
  pending: string;
  error: string | null;
  done: boolean;
};

const NOTE_MAX_CHARS = 160;

export function newTurn(id: string, question: string): Turn {
  return { id, question, steps: [], charts: [], answer: [], pending: "", error: null, done: false };
}

function closeThinking(steps: Step[], now: number): Step[] {
  const last = steps.at(-1);
  if (last?.kind !== "thinking" || last.endedAt !== null) return steps;
  return [...steps.slice(0, -1), { ...last, endedAt: now }];
}

/** Short text followed by more work is narration and folds into the steps; anything else is answer. */
function settlePending(turn: Turn, moreStepsFollow: boolean): Turn {
  const text = turn.pending.trim();
  if (!text) return { ...turn, pending: "" };
  if (moreStepsFollow && text.length <= NOTE_MAX_CHARS && !text.includes("\n")) {
    return { ...turn, pending: "", steps: [...turn.steps, { kind: "note", id: crypto.randomUUID(), text }] };
  }
  return { ...turn, pending: "", answer: [...turn.answer, text] };
}

export function finishTurn(turn: Turn, now: number, error: string | null = null): Turn {
  const settled = settlePending(turn, false);
  const steps = closeThinking(settled.steps, now).map((step) =>
    step.kind === "tool" && step.status === "running"
      ? { ...step, status: "error" as const, summary: "Stopped", endedAt: now }
      : step,
  );
  return { ...settled, steps, error: error ?? settled.error, done: true };
}

/** Folds one streamed event into the turn. */
export function applyEvent(turn: Turn, event: AssistantEvent, now: number): Turn {
  switch (event.type) {
    case "thinking": {
      const settled = settlePending(turn, true);
      const last = settled.steps.at(-1);
      if (last?.kind === "thinking" && last.endedAt === null) {
        return { ...settled, steps: [...settled.steps.slice(0, -1), { ...last, text: last.text + event.delta }] };
      }
      const step: Step = { kind: "thinking", id: crypto.randomUUID(), text: event.delta, startedAt: now, endedAt: null };
      return { ...settled, steps: [...settled.steps, step] };
    }
    case "text":
      return { ...turn, steps: closeThinking(turn.steps, now), pending: turn.pending + event.delta };
    case "tool_start": {
      const settled = settlePending(turn, true);
      const step: Step = {
        kind: "tool",
        id: event.id,
        label: event.label,
        activity: event.activity,
        detail: event.detail,
        input: event.input,
        status: "running",
        startedAt: now,
        endedAt: null,
      };
      return { ...settled, steps: [...closeThinking(settled.steps, now), step] };
    }
    case "tool_end":
      return {
        ...turn,
        steps: turn.steps.map((step) =>
          step.kind === "tool" && step.id === event.id
            ? { ...step, status: event.ok ? "done" : "error", summary: event.summary, result: event.result, ms: event.ms, endedAt: now }
            : step,
        ),
      };
    case "chart":
      return { ...turn, charts: [...turn.charts, { id: event.id, chart: event.chart }] };
    case "error": {
      const settled = settlePending(turn, false);
      return { ...settled, steps: closeThinking(settled.steps, now), error: event.message };
    }
    case "done":
      return finishTurn(turn, now);
    case "suggestion":
      // Belongs to the prompt bar, not the transcript.
      return turn;
  }
}
