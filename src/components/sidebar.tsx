"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, PanelLeftClose, PanelLeftOpen, Plug, User } from "lucide-react";
import { Wordmark } from "./wordmark";

const NAV = [{ href: "/analytics", label: "Analytics", icon: ChartColumn }];

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
  const pinned = useRef(false);
  const close = () => { pinned.current = false; setExpanded(false); };

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
      onPointerEnter={(event) => {
        // A direct click on the toggle must not first expand on hover and then collapse.
        if (event.pointerType === "mouse" && !(event.target instanceof Element && event.target.closest("[data-sidebar-toggle]"))) setExpanded(true);
      }}
      onPointerLeave={() => {
        if (!pinned.current && !rail.current?.querySelector(":focus-visible")) setExpanded(false);
      }}
      onFocusCapture={(event) => { if (event.target.matches(":focus-visible")) setExpanded(true); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !pinned.current) setExpanded(false);
      }}
      className="group/sidebar fixed inset-y-0 left-0 z-40 flex w-16 flex-col overflow-x-hidden overflow-y-auto border-r border-line bg-sidebar transition-[width] duration-200 ease-emphasized data-[expanded=true]:w-60 motion-reduce:transition-none"
    >
      <div className="flex h-16 shrink-0 items-center px-4">
        <Link href="/analytics" onClick={close} className={`rounded-sm text-white ${FOCUS}`}>
          <Wordmark className="h-5" tailClassName={TAIL} symbolClassName={SYMBOL} />
        </Link>
      </div>

      <div className="px-3">
        <button
          ref={toggle}
          data-sidebar-toggle
          type="button"
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded={expanded}
          aria-controls="romanum-sidebar"
          onClick={() => { pinned.current = !expanded; setExpanded(!expanded); }}
          className={`flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-fg-muted hover:bg-surface hover:text-fg ${FOCUS}`}
        >
          {expanded ? <PanelLeftClose className="size-5 shrink-0" aria-hidden="true" /> : <PanelLeftOpen className="size-5 shrink-0" aria-hidden="true" />}
          <span className={`text-sm ${LABEL}`}>Collapse</span>
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
        <div className="flex h-12 items-center gap-3 px-1.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-hover text-fg-muted">
            <User className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className={`text-sm text-fg ${LABEL}`}>Guest</span>
        </div>
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
