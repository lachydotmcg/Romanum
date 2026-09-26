"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";

const MCP_PATH = "/mcp";
const RESET_MS = 1600;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70";

// The origin comes from the browser instead of a configured domain, so the field always shows
// the host the user actually opened (localhost included). Nothing is known while rendering on
// the server, so the URL stays empty until hydration.
const subscribe = () => () => {};
const readOrigin = () => window.location.origin;
const readServerOrigin = () => "";

function isLocal(origin: string) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function ConnectionCard() {
  const origin = useSyncExternalStore(subscribe, readOrigin, readServerOrigin);
  const url = origin ? `${origin}${MCP_PATH}` : "";
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    if (!url) return;

    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage("Copied");
      timer.current = window.setTimeout(() => {
        setCopied(false);
        setMessage("");
      }, RESET_MS);
    } catch {
      // Insecure origins and denied permissions have no clipboard access, so select the field
      // and leave the user a single keystroke away from a manual copy.
      field.current?.focus();
      field.current?.select();
      setCopied(false);
      setMessage("Copy failed. Press Ctrl+C to copy the selected URL.");
    }
  }, [url]);

  return (
    <div className="rounded-xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="mcp-url" className="text-sm font-medium text-fg">
          Connection URL
        </label>
        {isLocal(origin) && <span className="text-xs text-fg-subtle">Local connection</span>}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          ref={field}
          id="mcp-url"
          readOnly
          value={url}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          className={`h-10 w-full min-w-0 rounded-lg border border-line bg-canvas px-3 font-mono text-sm text-fg sm:flex-1 ${FOCUS}`}
        />
        <button
          type="button"
          onClick={copy}
          disabled={!url}
          className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-surface-hover disabled:text-fg-subtle ${FOCUS}`}
        >
          {copied ? (
            <Check className="size-4 text-white" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Copy className="size-4 text-white" strokeWidth={1.75} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
          <span className="sr-only"> connection URL</span>
        </button>
      </div>

      <p role="status" className="mt-3 min-h-4 text-xs text-fg-subtle">
        {message}
      </p>
    </div>
  );
}
