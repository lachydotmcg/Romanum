"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, Gamepad2, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plug } from "lucide-react";
import type { ChatSummary } from "@/lib/chats/store";
import { compactCredits, creditsInDollars } from "@/lib/credits/value";
import { Avatar } from "./account/avatar";
import { ProfileMenu, type ProfileAccount } from "./account/profile-menu";
import { CHATS_CHANGED, CREDITS_CHANGED } from "./events";
import { Coin } from "./coin";
import { GitHubIcon } from "./github-icon";
import { Wordmark } from "./wordmark";

// Your games lives in the profile; this is its shortcut, since few people open a profile to find their games.
const NAV = [
  { href: "/analytics", label: "Analytics", icon: ChartColumn },
  { href: "/chats", label: "Chats", icon: MessagesSquare },
  { href: "/profile", label: "Your games", icon: Gamepad2 },
];
/** Recent chats listed in the open sidebar; the rest are on the Chats page. */
const RECENT_LIMIT = 10;

// One expansion state keeps touch, pointer, keyboard and the SVG reveal in sync.
const LABEL = "whitespace-nowrap opacity-0 transition-opacity duration-100 group-data-[expanded=true]/sidebar:opacity-100 group-data-[expanded=true]/sidebar:delay-150 motion-reduce:transition-none";
const TAIL = "[clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-200 ease-emphasized group-data-[expanded=true]/sidebar:[clip-path:inset(0)] motion-reduce:transition-none";
const SYMBOL = "rotate-0 translate-y-(--upright-y) transition-[rotate,translate] duration-200 ease-emphasized group-data-[expanded=true]/sidebar:rotate-(--tilt) group-data-[expanded=true]/sidebar:translate-y-0 group-data-[expanded=true]/sidebar:duration-550 group-data-[expanded=true]/sidebar:ease-fall motion-reduce:transition-none";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

/** The spendable credits: undefined while loading, null when the credit service is unavailable. */
function CreditBalance({ credits, compact = false, className = "" }: { credits: number | null | undefined; compact?: boolean; className?: string }) {
  const title =
    typeof credits === "number"
      ? `${credits.toLocaleString("en-US")} credits (${creditsInDollars(credits)})`
      : credits === null
        ? "Credits unavailable"
        : undefined;
  return (
    <span
      title={title}
      // Holds its space while loading, so the row doesn't shift when the balance arrives.
      className={`flex items-center text-fg-muted tabular-nums ${compact ? "gap-0.5 text-[10px] leading-3" : "gap-1.5"} ${
        credits === undefined ? "invisible" : ""
      } ${className}`}
    >
      <Coin className={`shrink-0 text-white ${compact ? "size-2.5" : "size-4"}`} />
      {typeof credits === "number" ? (compact ? compactCredits(credits) : credits.toLocaleString("en-US")) : "—"}
    </span>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const [credits, setCredits] = useState<number | null | undefined>(undefined);
  const [recent, setRecent] = useState<ChatSummary[]>([]);
  const [account, setAccount] = useState<ProfileAccount | null>(null);
  const [signInAvailable, setSignInAvailable] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => setExpanded(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    // Also creates the guest on its first visit, with its welcome credits. Reloaded whenever an answer is charged.
    const load = () =>
      fetch("/api/credits", { method: "POST", signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { available?: unknown } | null) => {
          if (active) setCredits(typeof data?.available === "number" ? data.available : null);
        })
        .catch(() => {
          if (active) setCredits(null);
        });
    load();
    window.addEventListener(CREDITS_CHANGED, load);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener(CREDITS_CHANGED, load);
    };
  }, []);

  useEffect(() => {
    let active = true;
    // Signing in and out reload the page, so once per page is enough.
    fetch("/api/account")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { account?: ProfileAccount | null; signInAvailable?: boolean } | null) => {
        if (!active) return;
        if (data?.account) setAccount(data.account);
        setSignInAvailable(data?.signInAvailable === true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/chats")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { chats?: unknown } | null) => {
          if (active && Array.isArray(data?.chats)) setRecent(data.chats as ChatSummary[]);
        })
        .catch(() => {});
    load();
    window.addEventListener(CHATS_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(CHATS_CHANGED, load);
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rail.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let the account menu or settings dialog handle its own dismissal first.
      if (event.defaultPrevented || rail.current?.querySelector(":popover-open, dialog[open]")) return;
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
          className={`absolute top-3 right-3 grid size-10 place-items-center rounded-lg bg-sidebar text-white transition-opacity duration-150 hover:bg-surface ${FOCUS} ${
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
          const active = pathname === href || pathname.startsWith(`${href}/`) || (href === "/chats" && pathname.startsWith("/projects"));
          return (
            <Link
              key={href}
              href={href}
              onClick={close}
              aria-current={active ? "page" : undefined}
              // Icons alone on the collapsed rail, so they get a tooltip there.
              title={expanded ? undefined : label}
              className={`flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors ${FOCUS} ${
                active ? "bg-surface text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"
              }`}
            >
              <Icon className="size-5 shrink-0 text-white" strokeWidth={1.75} aria-hidden="true" />
              <span className={LABEL}>{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Only in the open sidebar: the collapsed rail has no room for titles. */}
      {recent.length > 0 && (
        <nav aria-label="Recent chats" className="mt-5 hidden min-h-0 flex-col px-3 group-data-[expanded=true]/sidebar:flex">
          <p className="px-2.5 pb-1 text-xs whitespace-nowrap text-fg-subtle">Recent</p>
          <ul className="flex flex-col gap-0.5">
            {recent.slice(0, RECENT_LIMIT).map((chat) => {
              const active = pathname === `/chats/${chat.id}`;
              return (
                <li key={chat.id}>
                  <Link
                    href={`/chats/${chat.id}`}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className={`block truncate rounded-lg px-2.5 py-2 text-sm transition-colors ${FOCUS} ${
                      active ? "bg-surface text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"
                    }`}
                  >
                    {chat.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <div className="mt-auto flex flex-col gap-1 px-3 pb-3">
        <ProfileMenu
          account={account}
          credits={credits}
          signInAvailable={signInAvailable}
          onNavigate={close}
          className={`flex items-start gap-3 rounded-lg px-1.5 py-1.5 hover:bg-surface ${FOCUS}`}
        >
          <span className="flex w-7 shrink-0 flex-col items-center gap-1">
            <Avatar url={account?.pictureUrl} />
            {/* Collapsed, the balance sits under the avatar; expanded, it moves to the right of the name. */}
            <CreditBalance
              credits={credits}
              compact
              className="transition-opacity duration-100 group-data-[expanded=true]/sidebar:opacity-0 motion-reduce:transition-none"
            />
          </span>
          <span className={`flex h-7 min-w-0 items-center text-sm text-fg ${LABEL}`}>
            <span className="truncate">{account?.displayName ?? "Guest"}</span>
          </span>
          <CreditBalance credits={credits} className={`ml-auto h-7 text-sm ${LABEL}`} />
        </ProfileMenu>
        {/* Setup details live on a separate guide page, sourced from the repository. */}
        <div className="flex items-center gap-1">
          <Link
            href="/connect"
            onClick={close}
            aria-current={mcpActive ? "page" : undefined}
            aria-label="Get MCP"
            title="Get MCP"
            className={`flex h-10 min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors ${FOCUS} ${
              mcpActive ? "bg-surface text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"
            }`}
          >
            <Plug className="size-5 shrink-0 text-white" strokeWidth={1.75} aria-hidden="true" />
            <span className={LABEL}>Get MCP</span>
          </Link>
          <a
            href="https://github.com/romanumdev/Romanum"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Romanum on GitHub (opens in a new tab)"
            title="GitHub"
            className={`hidden size-10 shrink-0 place-items-center rounded-lg text-white hover:bg-surface group-data-[expanded=true]/sidebar:grid ${FOCUS}`}
          >
            <GitHubIcon className="size-5" />
          </a>
        </div>
      </div>
    </aside>
  );
}
