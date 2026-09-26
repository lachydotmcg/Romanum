import { Brain, Check, ChevronRight, CircleAlert, LoaderCircle, X } from "lucide-react";
import { AssistantMarkdown } from "./markdown";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string; startedAt: number; endedAt: number | null }
  | {
      kind: "tool";
      id: string;
      label: string;
      detail: string;
      input: unknown;
      status: "running" | "done" | "error";
      summary?: string;
      result?: unknown;
      ms?: number;
    }
  | { kind: "error"; id: string; text: string };

// Expandable action rows use <details>; this hides the default disclosure triangle.
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

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const Icon = item.status === "running" ? LoaderCircle : item.status === "done" ? Check : X;
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Icon
          className={`mt-0.5 size-4 shrink-0 ${item.status === "running" ? "animate-spin text-fg-muted" : "text-fg-muted"}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{item.label}</span>
          {item.detail && <span className="ml-2 text-fg-muted">{item.detail}</span>}
          {item.summary && <span className="block text-fg-muted">{item.summary}</span>}
          {item.status === "running" && <span className="block text-fg-subtle">Running…</span>}
        </span>
        {item.ms !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{(item.ms / 1000).toFixed(1)}s</span>}
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 mb-1 space-y-2 pl-6">
        <JsonBlock title="Input" value={item.input} />
        {item.result !== undefined && item.result !== null && <JsonBlock title="Result" value={item.result} />}
      </div>
    </details>
  );
}

function ThinkingRow({ item }: { item: Extract<TranscriptItem, { kind: "thinking" }> }) {
  const active = item.endedAt === null;
  const seconds = active ? 0 : Math.max(1, Math.round((item.endedAt! - item.startedAt) / 1000));
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Brain className={`mt-0.5 size-4 shrink-0 text-fg-muted ${active ? "animate-pulse" : ""}`} aria-hidden="true" />
        <span className="flex-1 text-fg-muted">{active ? "Thinking…" : `Thought for ${seconds}s`}</span>
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <p className="mt-1 mb-1 pl-6 text-xs leading-5 whitespace-pre-wrap text-fg-subtle">{item.text}</p>
    </details>
  );
}

export function Transcript({ items }: { items: TranscriptItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-lg bg-surface-hover px-3 py-2 text-sm whitespace-pre-wrap text-fg">
                  {item.text}
                </p>
              </div>
            );
          case "text":
            return (
              <div key={item.id} className="text-sm leading-6 text-fg">
                <AssistantMarkdown text={item.text} />
              </div>
            );
          case "thinking":
            return <ThinkingRow key={item.id} item={item} />;
          case "tool":
            return <ToolRow key={item.id} item={item} />;
          case "error":
            return (
              <p key={item.id} className="flex items-start gap-2 text-sm text-fg">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                {item.text}
              </p>
            );
        }
      })}
    </div>
  );
}
