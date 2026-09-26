"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { Transcript } from "./transcript";
import { applyEvent, finishTurn, newTurn, type Turn } from "./turns";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function Assistant({ connected }: { connected: boolean }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
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
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question || running) return;

    const userMessage: ApiMessage = { role: "user", content: question };
    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    const update = (change: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((turn) => (turn.id === turnId ? change(turn) : turn)));
    abortRef.current = controller;
    followRef.current = true;
    setInput("");
    setRunning(true);
    setTurns((prev) => [...prev, newTurn(turnId, question)]);

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
          update((turn) => applyEvent(turn, parsed, Date.now()));
        }
      }
      // If the stream ended without a "done" event, don't leave the turn spinning.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), "The response ended unexpectedly.")));
    } catch (error) {
      const message = controller.signal.aborted
        ? "Stopped."
        : error instanceof Error
          ? error.message
          : "Something went wrong.";
      update((turn) => finishTurn(turn, Date.now(), message));
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

      {turns.length === 0 ? (
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
          className="mt-3 max-h-[min(70vh,48rem)] overflow-y-auto rounded-xl border border-line p-4"
        >
          <Transcript turns={turns} />
        </div>
      )}
      <p role="status" className="sr-only">
        {running ? "The assistant is responding." : ""}
      </p>
    </section>
  );
}
