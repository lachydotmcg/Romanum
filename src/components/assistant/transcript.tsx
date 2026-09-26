import { Brain, Check, ChevronRight, CircleAlert, LoaderCircle, X } from "lucide-react";
import { ChartCard } from "@/components/charts/chart-card";
import { AssistantMarkdown } from "./markdown";
import type { Step, Turn } from "./turns";

// Expandable rows use <details>; this hides the default disclosure triangle.
const SUMMARY = "flex cursor-pointer list-none items-start gap-2 rounded-md py-1 [&::-webkit-details-marker]:hidden";

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs text-fg-subtle">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-xs leading-5 text-fg-muted">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ToolRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const Icon = step.status === "running" ? LoaderCircle : step.status === "done" ? Check : X;
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Icon
          className={`mt-0.5 size-4 shrink-0 text-white ${step.status === "running" ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{step.label}</span>
          {step.detail && <span className="ml-2 text-fg-muted">{step.detail}</span>}
          {step.summary && <span className="block text-fg-muted">{step.summary}</span>}
        </span>
        {step.ms !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{(step.ms / 1000).toFixed(1)}s</span>}
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-white transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 mb-1 space-y-2 pl-6">
        <JsonBlock title="Input" value={step.input} />
        {step.result !== undefined && step.result !== null && <JsonBlock title="Result" value={step.result} />}
      </div>
    </details>
  );
}

function ThinkingRow({ step }: { step: Extract<Step, { kind: "thinking" }> }) {
  const seconds = step.endedAt === null ? null : Math.max(1, Math.round((step.endedAt - step.startedAt) / 1000));
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Brain className="mt-0.5 size-4 shrink-0 text-white" aria-hidden="true" />
        <span className="flex-1 text-fg-muted">{seconds === null ? "Thinking…" : `Thought for ${seconds}s`}</span>
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-white transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <p className="mt-1 mb-1 pl-6 text-xs leading-5 whitespace-pre-wrap text-fg-subtle">{step.text}</p>
    </details>
  );
}

function headline(steps: Step[], active: boolean): string {
  if (active) {
    const current = [...steps]
      .reverse()
      .find((s) => (s.kind === "tool" && s.status === "running") || (s.kind === "thinking" && s.endedAt === null));
    if (current?.kind === "tool") return `${current.activity}…`;
    if (current?.kind === "thinking") return "Thinking…";
    return "Working…";
  }
  const timed = steps.filter((s): s is Exclude<Step, { kind: "note" }> => s.kind !== "note");
  const start = Math.min(...timed.map((s) => s.startedAt));
  const end = Math.max(...timed.map((s) => s.endedAt ?? s.startedAt));
  const seconds = Number.isFinite(start) ? Math.max(1, Math.round((end - start) / 1000)) : 0;
  if (timed.length === 1 && timed[0].kind === "thinking") return `Thought for ${seconds}s`;
  return `Worked for ${seconds}s · ${timed.length} ${timed.length === 1 ? "step" : "steps"}`;
}

/** Everything the assistant did for one answer, collapsed to a single live status line. */
function ProcessGroup({ steps, active }: { steps: Step[]; active: boolean }) {
  const failed = !active && steps.some((s) => s.kind === "tool" && s.status === "error");
  const Icon = active ? LoaderCircle : failed ? CircleAlert : Check;
  return (
    <details className="group/process text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-fg-muted [&::-webkit-details-marker]:hidden">
        <Icon className={`size-4 shrink-0 text-white ${active ? "animate-spin" : ""}`} aria-hidden="true" />
        <span className={active ? "text-fg" : ""}>{headline(steps, active)}</span>
        <ChevronRight
          className="size-4 shrink-0 text-white transition-transform group-open/process:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-1 ml-2 space-y-0.5 border-l border-line pl-4">
        {steps.length === 0 && <p className="py-1 text-fg-subtle">Waiting for the model…</p>}
        {steps.map((step) =>
          step.kind === "thinking" ? (
            <ThinkingRow key={step.id} step={step} />
          ) : step.kind === "tool" ? (
            <ToolRow key={step.id} step={step} />
          ) : (
            <p key={step.id} className="py-1 text-fg-muted">
              {step.text}
            </p>
          ),
        )}
      </div>
    </details>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const text = [...turn.answer, turn.pending].filter(Boolean).join("\n\n");
  // The process line shows while the model works, and afterwards if it did anything.
  const working = !turn.done && !turn.pending;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <p className="max-w-[min(85%,40rem)] rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-wrap text-fg">{turn.question}</p>
      </div>
      {(turn.steps.length > 0 || working) && <ProcessGroup steps={turn.steps} active={working} />}
      {turn.charts.map(({ id, chart }) => (
        <ChartCard key={id} chart={chart} />
      ))}
      {text && (
        // Charts may use the full width; prose stays at a comfortable line length.
        <div className="max-w-3xl text-sm leading-6 text-fg">
          <AssistantMarkdown text={text} />
        </div>
      )}
      {turn.error && (
        <p className="flex items-start gap-2 text-sm text-fg">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-white" aria-hidden="true" />
          {turn.error}
        </p>
      )}
    </div>
  );
}

export function Transcript({ turns }: { turns: Turn[] }) {
  return (
    <div className="space-y-6">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}
    </div>
  );
}
