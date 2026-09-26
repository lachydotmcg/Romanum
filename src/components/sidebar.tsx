"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, Plug, User } from "lucide-react";
import { Wordmark } from "./wordmark";

const NAV = [{ href: "/analytics", label: "Analytics", icon: ChartColumn }];

// The rail widens on hover (after a short delay) or when something inside has keyboard focus.
// Everything that appears on expansion shares these states.
const EXPAND_DELAY = "group-hover/sidebar:delay-100";

// Labels fade in once the rail has mostly widened, and fade out straight away on collapse.
const LABEL =
  "whitespace-nowrap opacity-0 transition-opacity duration-100 group-hover/sidebar:opacity-100 group-hover/sidebar:duration-200 group-hover/sidebar:delay-200 group-has-focus-visible/sidebar:opacity-100 motion-reduce:transition-none";

// "manum" is wiped in from behind "Ro" in step with the rail's width.
const TAIL = `[clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-200 ease-emphasized group-hover/sidebar:[clip-path:inset(0)] ${EXPAND_DELAY} group-has-focus-visible/sidebar:[clip-path:inset(0)] motion-reduce:transition-none`;

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="group/sidebar fixed inset-y-0 left-0 z-40 flex w-16 flex-col overflow-hidden border-r border-line bg-sidebar transition-[width] duration-200 ease-emphasized hover:w-60 hover:delay-100 has-focus-visible:w-60 motion-reduce:transition-none">
      <div className="flex h-16 shrink-0 items-center px-4">
        <Link href="/analytics" className={`rounded-sm text-white ${FOCUS}`}>
          <Wordmark className="h-5" tailClassName={TAIL} />
        </Link>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-1 px-3 pt-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors ${FOCUS} ${
                active ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"
              }`}
            >
              <Icon className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className={LABEL}>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 px-3 pb-3">
        {/* MCP access isn't built yet, so this stays inert and says so. */}
        <button
          type="button"
          aria-disabled="true"
          className={`flex h-12 cursor-default items-center gap-3 rounded-lg px-2.5 text-left text-fg-muted ${FOCUS}`}
        >
          <Plug className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className={`flex flex-col ${LABEL}`}>
            <span className="text-sm font-medium">Get MCP</span>
            <span className="text-xs text-fg-subtle">Not available yet</span>
          </span>
        </button>

        <div className="flex h-12 items-center gap-3 px-1.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-hover text-fg-muted">
            <User className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className={`text-sm text-fg ${LABEL}`}>Guest</span>
        </div>
      </div>
    </aside>
  );
}
