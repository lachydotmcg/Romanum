"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Folder } from "lucide-react";
import { Transcript } from "@/components/assistant/transcript";
import { applyEvent, finishTurn, newTurn, type Turn } from "@/components/assistant/turns";
import type { AssistantEvent } from "@/lib/assistant/types";
import type { ChatSummary, StoredMessage } from "@/lib/chats/store";
import { Composer, type PendingImage } from "./composer";
import { CHATS_CHANGED, CREDITS_CHANGED } from "@/components/events";
import { RecentChats } from "./recent-chats";
import { useVerifiedFetch } from "../verification";
import type { ProjectBrief, ProjectSummary } from "@/lib/projects/store";
import { ProjectPanel } from "./project-panel";
import { WorkspaceList } from "./workspace-list";
import contextStyles from "./project-context.module.css";

const attachmentUrl = (id: string) => `/api/chat-attachments/${id}`;
const STARTERS = [
  { label: "Give me ideas", prompt: "Give me a few Roblox game ideas grounded in current data and existing games. Help me choose one before we work through its hooks, game design, roadmap and implementation." },
  { label: "I have an idea", prompt: "I have a Roblox game idea. Ask me about it, then help me work through its hooks and game design before we plan the roadmap and implementation." },
  { label: "I have a game already", prompt: "Help me work out the next steps for my existing Roblox game. Start by asking what I've built so far." },
];

/** Redraws saved messages: each question starts a turn, and its answer's recorded events replay onto it. */
function replay(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const attachments = message.attachments.map((file) => ({ ...file, url: attachmentUrl(file.id) }));
      turns.push({ ...newTurn(message.id, message.content), attachments });
    } else if (turns.length) {
      let turn = turns[turns.length - 1];
      for (const { t, e } of message.events) turn = applyEvent(turn, e, t);
      turns[turns.length - 1] = turn.done ? turn : finishTurn(turn, message.events.at(-1)?.t ?? 0);
    }
  }
  return turns.map((turn) => (turn.done ? turn : finishTurn(turn, 0, "No answer was saved.")));
}

/**
 * A chat: a new one (no chatId) or a saved one. The first question saves it and gives it its own address. Empty,
 * it shows the prompt bar in the middle with recent chats below; once it has messages, the bar sits at the bottom.
 */
export function ChatView({
  chatId,
  initialMessages,
  recent,
  connected,
  project: initialProject = null,
  canPlan = false,
  projects = [],
  archived = false,
  contextTab,
}: {
  chatId: string | null;
  initialMessages: StoredMessage[];
  recent: ChatSummary[] | null;
  connected: boolean;
  project?: ProjectBrief | null;
  canPlan?: boolean;
  projects?: ProjectSummary[];
  archived?: boolean;
  contextTab?: string;
}) {
  const verifiedFetch = useVerifiedFetch();
  const [turns, setTurns] = useState<Turn[]>(() => replay(initialMessages));
  const [running, setRunning] = useState(false);
  const [project, setProject] = useState(initialProject);
  const [contextExpanded, setContextExpanded] = useState(Boolean(contextTab));
  const [contextAnimation, setContextAnimation] = useState(0);
  const projectSaved = useCallback((next: ProjectBrief) => setProject(current => current?.id === next.id && current.revision > next.revision ? current : next), []);
  const chatRef = useRef(chatId);
  const abortRef = useRef<AbortController | null>(null);
  // An older stream may finish closing after the next question starts.
  const requestRef = useRef(0);
  // Follow new output unless the reader has scrolled up to read.
  const followRef = useRef(true);
  // Preview URLs of images sent from this page, released when it closes.
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const owned = previews.current;
    return () => {
      abortRef.current?.abort();
      owned.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const onScroll = () => {
      followRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (followRef.current && turns.length) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns]);

  async function ask(question: string, images: PendingImage[]) {
    if (running) return;
    // Close any remaining stream from the previous answer.
    abortRef.current?.abort();
    const request = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const turnId = crypto.randomUUID();
    const update = (change: (turn: Turn) => Turn) => setTurns((prev) => prev.map((turn) => (turn.id === turnId ? change(turn) : turn)));
    for (const image of images) previews.current.add(image.url);
    followRef.current = true;
    setRunning(true);
    setTurns((prev) => [
      ...prev,
      { ...newTurn(turnId, question), attachments: images.map((image) => ({ id: image.id, name: image.file.name, url: image.url })) },
    ]);

    const body = new FormData();
    if (chatRef.current) body.set("chatId", chatRef.current);
    if (project) body.set("projectId", project.id);
    body.set("text", question);
    for (const image of images) body.append("files", image.file, image.file.name);

    try {
      const res = await verifiedFetch("/api/chats", { method: "POST", body, signal: controller.signal });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `The chat request failed (${res.status}).`);
      }
      const id = res.headers.get("x-chat-id");
      if (id && !chatRef.current) {
        chatRef.current = id;
        // The new chat gets its own address without reloading the page.
        window.history.replaceState(null, "", `/chats/${id}`);
      }
      window.dispatchEvent(new Event(CHATS_CHANGED));

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
          const event = JSON.parse(line) as AssistantEvent;
          if (event.type === "project_context") { projectSaved(event.project); setContextAnimation(version => version + 1); window.dispatchEvent(new Event(CHATS_CHANGED)); }
          if (event.type === "suggestion") continue; // Ignore legacy server events during deploys.
          if (event.type === "done") setRunning(false);
          update((turn) => applyEvent(turn, event, Date.now()));
          if (event.type === "usage") window.dispatchEvent(new Event(CREDITS_CHANGED));
        }
      }
      // If the stream ended without a "done" event, don't leave the turn spinning.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), "The response ended unexpectedly.")));
    } catch (error) {
      const message = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : "Something went wrong.";
      // A completed answer stays intact if its remaining stream is interrupted.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), message)));
    } finally {
      if (request === requestRef.current) setRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const empty = turns.length === 0;
  return (
    <div className={project ? `${contextStyles.workspace} ${contextExpanded ? contextStyles.workspaceExpanded : ""}` : undefined}>
    {/* The negative margin cancels the page's bottom padding, so the prompt bar can sit at the very bottom. */}
    <div
      className={`mx-auto -mb-6 flex min-h-[calc(100dvh-1.5rem)] w-full min-w-0 max-w-3xl flex-col sm:-mb-8 sm:min-h-[calc(100dvh-2rem)] ${
        empty ? "justify-center pb-6 sm:pb-8" : ""
      }`}
    >
      {project ? <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 flex-1 items-center gap-2 text-sm"><Folder className="size-4 shrink-0" /><span className="truncate">{project.name}</span>{project.archived && <span className="text-xs text-fg-muted">Archived</span>}</div>{!project.archived && <Link href={`/chats?project=${project.id}`} className="rounded text-xs text-fg-muted hover:text-fg focus-visible:outline-2">New chat</Link>}</header> : !empty && canPlan ? <div className="mb-4 flex justify-end"><button type="button" disabled={running} onClick={() => void ask("Help me turn this conversation into a game plan. Ask about anything important that's missing, then save our agreed plan, roadmap and to-dos as project context.", [])} className="min-h-10 rounded-lg border border-line px-3 text-xs text-fg-muted hover:text-fg disabled:opacity-40">Plan this game</button></div> : null}
      {empty ? (
        <h1 key="heading" className="mb-6 text-center text-2xl font-semibold tracking-tight">
          {project?.archived ? "This project is archived" : "What are we making?"}
        </h1>
      ) : (
        <div key="transcript" className="flex-1 pb-6" aria-busy={running}>
          <Transcript turns={turns} />
        </div>
      )}
      {!(empty && project?.archived) && <div key="composer" className={empty ? "" : "sticky bottom-0 z-20 pb-4"}>
        {/* The conversation scrolls under the bar through a blur that fades out above it. */}
        {!empty && (
          <div className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 backdrop-blur-xl [mask-image:linear-gradient(to_top,black_calc(100%_-_2.5rem),transparent)] [@media(prefers-reduced-transparency:reduce)]:bg-canvas" />
        )}
        <Composer
          projectId={project?.id}
          connected={connected}
          running={running}
          onSend={ask}
          onStop={() => abortRef.current?.abort()}
          starters={!empty ? [] : !project ? STARTERS : !project.archived ? [{ label: "Plan next steps", prompt: "Help me review this game's plan and work out the next steps. Save the agreed roadmap and to-dos in context." }, { label: "Plan a thumbnail", prompt: "Create and save a thumbnail plan for this project." }, { label: "Plan a UI", prompt: "Create and save a UI plan for this project. Ask me which screen to design first." }] : []}
        />
      </div>}
      {empty && !project && canPlan && (projects.length > 0 || archived) && <WorkspaceList projects={projects} archived={archived} />}
      {empty && recent && <RecentChats key="recent" initial={recent} />}
      <p role="status" className="sr-only">
        {running ? "The assistant is responding." : ""}
      </p>
    </div>
    {project && <ProjectPanel project={project} onSaved={projectSaved} initialTab={contextTab} expanded={contextExpanded} onExpandedChange={setContextExpanded} animationVersion={contextAnimation} />}
    </div>
  );
}
