"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, Gamepad2, PanelLeftClose, PanelLeftOpen, Plug, User } from "lucide-react";
import { Wordmark } from "./wordmark";

// Your games lives in the profile; this is its shortcut, since few people open a profile to find their games.
const NAV = [
  { href: "/analytics", label: "Analytics", icon: ChartColumn },
  { href: "/profile", label: "Your games", icon: Gamepad2 },
];

// One expansion state keeps touch, pointer, keyboard and the SVG reveal in sync.
const LABEL = "whitespace-nowrap opacity-0 transition-opacity duration-100 group-data-[expanded=true]/sidebar:opacity-100 group-data-[expanded=true]/sidebar:delay-150 motion-reduce:transition-none";
const TAIL = "[clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-200 ease-emphasized group-data-[expanded=true]/sidebar:[clip-path:inset(0)] motion-reduce:transition-none";
const SYMBOL = "rotate-0 translate-y-(--upright-y) transition-[rotate,translate] duration-200 ease-emphasized group-data-[expanded=true]/sidebar:rotate-(--tilt) group-data-[expanded=true]/sidebar:translate-y-0 group-data-[expanded=true]/sidebar:duration-550 group-data-[expanded=true]/sidebar:ease-fall motion-reduce:transition-none";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

export function Sidebar() {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => setExpanded(false);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rail.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (rail.current?.contains(document.activeElement)) toggle.current?.focus();
      close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);
  const mcpActive = pathname === "/connect" || pathname.startsWith("/connect/");

  return (
    <aside
      ref={rail}
      id="romanum-sidebar"
      data-expanded={expanded}
      className="group/sidebar fixed inset-y-0 left-0 z-40 flex w-16 flex-col overflow-x-hidden overflow-y-auto border-r border-line bg-sidebar transition-[width] duration-200 ease-emphasized data-[expanded=true]:w-60 motion-reduce:transition-none"
    >
      {/* As in ChatGPT: collapsed, hovering the "Ro" logo turns it into the open button; expanded, the
          close button sits at the right. The button is pinned right-3, so on the 64px rail it covers the
          logo and it glides with the edge as the rail opens and closes. */}
      <div className="group/logo relative flex h-16 shrink-0 items-center px-4">
        <Link
          href="/analytics"
          onClick={close}
          tabIndex={expanded ? undefined : -1}
          aria-hidden={expanded ? undefined : true}
          className={`rounded-sm text-white ${FOCUS}`}
        >
          <Wordmark className="h-5" tailClassName={TAIL} symbolClassName={SYMBOL} />
        </Link>
        <button
          ref={toggle}
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-label={expanded ? "Close sidebar" : "Open sidebar"}
          title={expanded ? "Close sidebar" : "Open sidebar"}
          aria-expanded={expanded}
          aria-controls="romanum-sidebar"
          className={`absolute top-3 right-3 grid size-10 place-items-center rounded-lg bg-sidebar text-fg-muted transition-opacity duration-150 hover:bg-surface hover:text-fg ${FOCUS} ${
            expanded ? "" : "opacity-0 group-hover/logo:opacity-100 focus-visible:opacity-100"
          }`}
        >
          {expanded ? (
            <PanelLeftClose className="size-5" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftOpen className="size-5" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-1 px-3 pt-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={close}
              aria-current={active ? "page" : undefined}
              // Icons alone on the collapsed rail, so they get a tooltip there.
              title={expanded ? undefined : label}
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
        <Link
          href="/profile"
          onClick={close}
          aria-label="Profile"
          title={expanded ? undefined : "Profile"}
          className={`flex h-12 items-center gap-3 rounded-lg px-1.5 hover:bg-surface ${FOCUS}`}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-hover text-fg-muted">
            <User className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className={`text-sm text-fg ${LABEL}`}>Guest</span>
        </Link>
        {/* Setup details live on a separate guide page, sourced from the repository. */}
        <Link
          href="/connect"
          onClick={close}
          aria-current={mcpActive ? "page" : undefined}
          aria-label="Get MCP"
          title="Get MCP"
          className={`flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors ${FOCUS} ${
            mcpActive ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"
          }`}
        >
          <Plug className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className={LABEL}>Get MCP</span>
        </Link>
      </div>
    </aside>
  );
}
