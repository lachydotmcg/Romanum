"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import Link from "next/link";
import { CREDITS_CHANGED } from "@/components/events";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { Transcript } from "./transcript";
import { applyEvent, finishTurn, newTurn, type Turn } from "./turns";
import { PREFILL_EVENT, type AssistantPrefill } from "./prefill";
import { useVerifiedFetch } from "../verification";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function Assistant({ connected, initialPrompt = "" }: { connected: boolean; initialPrompt?: string }) {
  const verifiedFetch = useVerifiedFetch();
  const [input, setInput] = useState(initialPrompt);
  const [turns, setTurns] = useState<Turn[]>([]);
  // The conversation in API form, including tool results and DeepSeek's reasoning, sent back on each question.
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [running, setRunning] = useState(false);
  // The model's guess at the next question: shown in the empty prompt bar and accepted with Tab.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Only the newest request may update the prompt bar; an older stream can still be delivering its suggestion.
  const requestRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  // Whether the bar is pinned to the top of the screen; the blur behind it only shows then.
  const [pinned, setPinned] = useState(false);
  // Follow new output unless the reader has scrolled up.
  const followRef = useRef(true);
  // Set when a question is sent, so its answer is scrolled into view even when asked from far down the page.
  const revealRef = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const prefill = (event: Event) => {
      const detail = (event as CustomEvent<AssistantPrefill>).detail;
      if (!connected || !detail || typeof detail.prompt !== "string") return;
      setInput(detail.prompt.slice(0, 4000));
    };
    window.addEventListener(PREFILL_EVENT, prefill);
    return () => window.removeEventListener(PREFILL_EVENT, prefill);
  }, [connected]);

  useEffect(() => {
    const band = bandRef.current;
    if (!band) return;
    // A pinned band sits at the very top, so its top pixel falls outside a root shrunk by 1px.
    const observer = new IntersectionObserver(
      ([entry]) => setPinned(entry.intersectionRatio < 1 && entry.boundingClientRect.top < 1),
      { rootMargin: "-1px 0px 0px 0px", threshold: 1 },
    );
    observer.observe(band);
    return () => observer.disconnect();
  }, [connected]);

  useEffect(() => {
    if (!revealRef.current) return;
    revealRef.current = false;
    const panel = scrollRef.current?.getBoundingClientRect();
    const band = bandRef.current?.getBoundingClientRect();
    // Asked from further down the page: scroll back up to the answers. The extra 12px lets the bar settle back
    // into its place above them, rather than staying pinned with its blur over the start of the answers.
    if (!panel || !band || panel.top >= band.bottom) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: panel.top - band.bottom - 12, behavior: reduceMotion ? "auto" : "smooth" });
  }, [turns.length]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question || running) return;

    // The previous answer is finished but its stream may still be waiting on a suggestion.
    abortRef.current?.abort();
    const request = ++requestRef.current;
    const userMessage: ApiMessage = { role: "user", content: question };
    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    const update = (change: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((turn) => (turn.id === turnId ? change(turn) : turn)));
    abortRef.current = controller;
    followRef.current = true;
    revealRef.current = true;
    setInput("");
    setSuggestion(null);
    setRunning(true);
    setTurns((prev) => [...prev, newTurn(turnId, question)]);

    try {
      const res = await verifiedFetch("/api/assistant", {
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
          if (parsed.type === "suggestion") {
            if (request === requestRef.current) setSuggestion(parsed.text);
            continue;
          }
          if (parsed.type === "done") {
            setHistory((prev) => [...prev, userMessage, ...parsed.messages]);
            // The answer is complete; the prompt bar is usable while the suggestion loads.
            setRunning(false);
          }
          update((turn) => applyEvent(turn, parsed, Date.now()));
          if (parsed.type === "usage") window.dispatchEvent(new Event(CREDITS_CHANGED));
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
      // A finished answer whose suggestion stream was cut off stays as it was.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), message)));
    } finally {
      if (request === requestRef.current) setRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
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
            placeholder="Ask Romanum…"
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
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover text-white/40 disabled:cursor-not-allowed"
          >
            <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  // Once pinned, the bar springs into a narrower, centred pill, like Apple's Dynamic Island, and its buttons
  // round off to match.
  const reshape = "duration-500 ease-spring motion-reduce:transition-none";
  const barShape = pinned ? "max-w-xl rounded-3xl" : "max-w-full rounded-xl";
  const buttonShape = pinned ? "rounded-2xl" : "rounded-lg";

  // No wrapper element: a sticky element only sticks within its parent, and the bar stays pinned down the whole page.
  return (
    <>
      {/* Pinned to the top of the screen once you scroll to it. The band's negative margin cancels its padding,
          so the bar sits where it did. Clicks beside the bar reach the page underneath, and the blur around the bar
          is clipped to the page column. Solid black instead when the system asks for less transparency. */}
      <div
        ref={bandRef}
        data-pinned-prompt
        className="pointer-events-none sticky top-0 z-30 -my-3 overflow-x-clip py-3 [@media(prefers-reduced-transparency:reduce)]:bg-canvas"
      >
        <form
          onSubmit={ask}
          aria-label="AI assistant"
          className={`pointer-events-auto relative mx-auto flex h-12 items-center gap-3 border border-line bg-surface pr-2 pl-4 transition-[max-width,border-radius] focus-within:border-line-strong ${reshape} ${barShape}`}
        >
          {/* While pinned, the page around the bar is blurred, fading out 4rem beyond its ends and below it so the
              two blend. Sized from the bar, so it narrows along with it; it starts just above the screen's top edge. */}
          <div
            className={`pointer-events-none absolute -inset-x-16 -top-4 -bottom-11 -z-10 backdrop-blur-xl transition-opacity [mask-image:linear-gradient(to_right,transparent,black_4rem,black_calc(100%_-_4rem),transparent),linear-gradient(to_bottom,black_calc(100%_-_2.75rem),transparent)] [mask-composite:intersect] [@media(prefers-reduced-transparency:reduce)]:hidden ${reshape} ${
              pinned ? "opacity-100" : "opacity-0"
            }`}
          />
          <label htmlFor="ai-prompt" className="sr-only">
            Ask the AI assistant
          </label>
          <input
            ref={inputRef}
            id="ai-prompt"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Tab only takes the suggestion while the bar is empty; otherwise it moves focus as usual.
              if (e.key === "Tab" && !e.shiftKey && suggestion && !input) {
                e.preventDefault();
                setInput(suggestion);
              } else if (e.key === "Escape" && suggestion && !input) {
                setSuggestion(null);
              }
            }}
            placeholder={suggestion ?? "Ask Romanum…"}
            aria-describedby={suggestion && !input ? "ai-suggestion-hint" : undefined}
            maxLength={4000}
            autoComplete="off"
            className={`min-w-0 flex-1 bg-transparent text-sm text-ellipsis text-fg focus:outline-none ${
              suggestion ? "placeholder:text-fg-muted" : "placeholder:text-fg-subtle"
            }`}
          />
          {suggestion && !input && !running && (
            <button
              type="button"
              onClick={() => {
                setInput(suggestion);
                inputRef.current?.focus();
              }}
              aria-label={`Use suggestion: ${suggestion}`}
              className={`shrink-0 rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] leading-4 text-fg-muted hover:bg-surface-hover hover:text-fg ${FOCUS}`}
            >
              Tab
            </button>
          )}
          <span id="ai-suggestion-hint" className="sr-only">
            Press Tab to use the suggested question.
          </span>
          {running ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
              className={`grid size-8 shrink-0 place-items-center bg-surface-hover text-fg transition-[border-radius] ${reshape} ${buttonShape} ${FOCUS}`}
            >
              <Square className="size-3.5 fill-current text-white" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send"
              className={`grid size-8 shrink-0 place-items-center bg-white text-black transition-[border-radius] disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-white/40 ${reshape} ${buttonShape} ${FOCUS}`}
            >
              <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </form>
      </div>

      <Link href="/privacy#ai" target="_blank" className={`inline-flex min-h-9 items-center self-end rounded-sm text-xs text-fg-muted hover:text-fg ${FOCUS}`}>AI privacy</Link>
      {turns.length > 0 && (
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
    </>
  );
}
