"use client";

import { useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import type { ChatSummary } from "@/lib/chats/store";
import { CHATS_CHANGED } from "@/components/events";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

function ago(iso: string) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return "just now";
}

/** The guest's saved chats, most recent first, each with a way to delete it. */
export function RecentChats({ initial }: { initial: ChatSummary[] }) {
  const [chats, setChats] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function remove(chat: ChatSummary) {
    if (!window.confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
    setError(null);
    const res = await fetch(`/api/chats/${chat.id}`, { method: "DELETE" }).catch(() => null);
    if (res && (res.ok || res.status === 404)) {
      setChats((prev) => prev.filter((item) => item.id !== chat.id));
      window.dispatchEvent(new Event(CHATS_CHANGED));
    } else {
      setError("Couldn't delete that chat. Try again.");
    }
  }

  if (!chats.length) return null;
  return (
    <section aria-labelledby="recent-chats" className="mt-10">
      <h2 id="recent-chats" className="mb-1 px-3 text-xs font-medium text-fg-subtle">
        Recent
      </h2>
      <ul>
        {chats.map((chat) => (
          <li key={chat.id} className="group flex items-center rounded-lg hover:bg-surface">
            <Link
              href={`/chats/${chat.id}`}
              className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2.5 text-sm text-fg-muted group-hover:text-fg ${FOCUS}`}
            >
              {chat.title}
            </Link>
            {/* Relative to the reader's clock, so the server's render can differ by a minute. */}
            <time dateTime={chat.updatedAt} suppressHydrationWarning className="shrink-0 px-2 text-xs text-fg-subtle">
              {ago(chat.updatedAt)}
            </time>
            <button
              type="button"
              onClick={() => remove(chat)}
              aria-label={`Delete ${chat.title}`}
              title="Delete"
              className={`mr-1 grid size-8 shrink-0 place-items-center rounded-md text-white opacity-0 group-hover:opacity-100 hover:bg-surface-hover focus-visible:opacity-100 ${FOCUS}`}
            >
              <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 px-3 text-xs text-fg-muted">
          {error}
        </p>
      )}
    </section>
  );
}
