"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { Transcript, type TranscriptItem } from "./transcript";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

function closeThinking(items: TranscriptItem[], now: number): TranscriptItem[] {
  const last = items.at(-1);
  if (last?.kind !== "thinking" || last.endedAt !== null) return items;
  return [...items.slice(0, -1), { ...last, endedAt: now }];
}

/** Folds one streamed event into the transcript. */
function applyEvent(items: TranscriptItem[], event: AssistantEvent, now: number): TranscriptItem[] {
  switch (event.type) {
    case "thinking": {
      const last = items.at(-1);
      if (last?.kind === "thinking" && last.endedAt === null) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }];
      }
      return [...items, { kind: "thinking", id: crypto.randomUUID(), text: event.delta, startedAt: now, endedAt: null }];
    }
    case "text": {
      const settled = closeThinking(items, now);
      const last = settled.at(-1);
      if (last?.kind === "text") return [...settled.slice(0, -1), { ...last, text: last.text + event.delta }];
      return [...settled, { kind: "text", id: crypto.randomUUID(), text: event.delta }];
    }
    case "tool_start":
      return [
        ...closeThinking(items, now),
        { kind: "tool", id: event.id, label: event.label, detail: event.detail, input: event.input, status: "running" },
      ];
    case "tool_end":
      return items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? { ...item, status: event.ok ? "done" : "error", summary: event.summary, result: event.result, ms: event.ms }
          : item,
      );
    case "error":
      return [...closeThinking(items, now), { kind: "error", id: crypto.randomUUID(), text: event.message }];
    case "done":
      return closeThinking(items, now);
  }
}

export function Assistant({ connected }: { connected: boolean }) {
  const [input, setInput] = useState("");
  const [items, setItems] = useState<TranscriptItem[]>([]);
  // The conversation in API form, including tool results and DeepSeek's reasoning, sent back on each question.
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new output unless the reader has scrolled up.
  const followRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question || running) return;

    const userMessage: ApiMessage = { role: "user", content: question };
    const controller = new AbortController();
    abortRef.current = controller;
    followRef.current = true;
    setInput("");
    setRunning(true);
    setItems((prev) => [...prev, { kind: "user", id: crypto.randomUUID(), text: question }]);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [...history, userMessage] }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The assistant request failed (${res.status}).`);
      }

      // The route streams one JSON event per line.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const parsed = JSON.parse(line) as AssistantEvent;
          if (parsed.type === "done") setHistory((prev) => [...prev, userMessage, ...parsed.messages]);
          setItems((prev) => applyEvent(prev, parsed, Date.now()));
        }
      }
    } catch (error) {
      const stopped = controller.signal.aborted;
      setItems((prev) => [
        ...closeThinking(prev, Date.now()).map((item) =>
          item.kind === "tool" && item.status === "running" ? { ...item, status: "error" as const, summary: "Stopped" } : item,
        ),
        {
          kind: "error",
          id: crypto.randomUUID(),
          text: stopped ? "Stopped." : error instanceof Error ? error.message : "Something went wrong.",
        },
      ]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  if (!connected) {
    return (
      <section aria-label="AI assistant">
        <div className="flex h-12 items-center gap-3 rounded-xl border border-line bg-surface pr-2 pl-4">
          <label htmlFor="ai-prompt" className="sr-only">
            Ask the AI assistant
          </label>
          <input
            id="ai-prompt"
            type="text"
            disabled
            placeholder="Ask about your analytics"
            aria-describedby="ai-status"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none disabled:cursor-not-allowed"
          />
          <span
            id="ai-status"
            className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-xs text-fg-muted"
          >
            Not connected
          </span>
          <button
            type="button"
            disabled
            aria-label="Send"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover text-fg-subtle disabled:cursor-not-allowed"
          >
            <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="AI assistant">
      <form
        onSubmit={ask}
        className="flex h-12 items-center gap-3 rounded-xl border border-line bg-surface pr-2 pl-4 focus-within:border-line-strong"
      >
        <label htmlFor="ai-prompt" className="sr-only">
          Ask the AI assistant
        </label>
        <input
          id="ai-prompt"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about any Roblox game"
          maxLength={4000}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
        />
        {running ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            aria-label="Stop"
            className={`grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover text-fg ${FOCUS}`}
          >
            <Square className="size-3.5 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="Send"
            className={`grid size-8 shrink-0 place-items-center rounded-lg bg-fg text-canvas disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-subtle ${FOCUS}`}
          >
            <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </form>

      {items.length === 0 ? (
        <p className="mt-2 text-xs text-fg-muted">
          Uses public Roblox data only. Revenue estimates aren&apos;t available yet.
        </p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          aria-busy={running}
          className="mt-3 max-h-[min(60vh,36rem)] overflow-y-auto rounded-xl border border-line p-4 tabular-nums"
        >
          <Transcript items={items} />
        </div>
      )}
      <p role="status" className="sr-only">
        {running ? "The assistant is responding." : ""}
      </p>
    </section>
  );
}
