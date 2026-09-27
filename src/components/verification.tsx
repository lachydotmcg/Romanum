"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { TurnstileAction } from "@/lib/turnstile";

type Challenge = { action: TurnstileAction; siteKey: string; finish: (token: string | null) => void };
type Turnstile = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: Turnstile } }
let script: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  if (script) return script;
  script = new Promise((resolve, reject) => {
    if (window.turnstile) { resolve(window.turnstile); return; }
    const element = document.createElement("script");
    const failed = () => { element.remove(); script = undefined; reject(new Error("Verification couldn't load.")); };
    const timeout = window.setTimeout(failed, 15_000);
    element.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    element.async = true;
    element.onerror = () => { window.clearTimeout(timeout); failed(); };
    element.onload = () => {
      window.clearTimeout(timeout);
      if (!window.turnstile) { failed(); return; }
      resolve(window.turnstile);
    };
    document.head.appendChild(element);
  });
  return script;
}

function ChallengeWidget({ challenge }: { challenge: Challenge }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let widget: string | undefined;
    let api: Turnstile | undefined;
    loadTurnstile().then((loaded) => {
      if (!active || !container.current) return;
      api = loaded;
      const failed = () => { if (active) setError(true); };
      widget = loaded.render(container.current, {
        sitekey: challenge.siteKey, action: challenge.action, theme: "dark", size: "flexible",
        "response-field": false, retry: "never", "refresh-expired": "manual",
        callback: (token: string) => { if (active) challenge.finish(token); },
        "error-callback": failed, "expired-callback": failed, "timeout-callback": failed,
      });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; if (widget !== undefined) api?.remove(widget); };
  }, [challenge, attempt]);

  return (
    <section aria-label="Verification" className="fixed right-2 bottom-3 z-50 w-[316px] max-w-[calc(100vw-16px)] rounded-xl border border-line bg-surface p-2 sm:right-5 sm:bottom-5">
      <div className="mb-2 flex items-center justify-between gap-2 pl-2">
        <p role="status" className="text-sm">{error ? "Verification failed." : "Verifying…"}</p>
        <button type="button" aria-label="Cancel verification" onClick={() => challenge.finish(null)} className="grid size-8 place-items-center rounded-lg text-white hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg"><X className="size-4" /></button>
      </div>
      <div ref={container} />
      {error && <button type="button" onClick={() => { setError(false); setAttempt((value) => value + 1); }} className="mt-2 min-h-10 w-full rounded-lg bg-surface-hover text-sm focus-visible:outline-2 focus-visible:outline-fg">Try again</button>}
    </section>
  );
}

type VerifiedFetch = (url: string, init?: RequestInit) => Promise<Response>;
const VerificationContext = createContext<VerifiedFetch | null>(null);

/** One shared widget queue: each protected request gets its own single-use token. */
export function VerificationProvider({ children }: { children: ReactNode }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const verifiedFetch = useCallback<VerifiedFetch>(async (url, init) => {
    // Only Romanum's relative routes may receive a verification token.
    if (!url.startsWith("/") || url.startsWith("//")) throw new Error("Invalid request.");
    const response = await fetch(url, init);
    if (response.status !== 403) return response;
    const data = await response.clone().json().catch(() => null);
    if (data?.code !== "verification_required" || typeof data.siteKey !== "string" || !["guest", "roblox_signin"].includes(data.action)) return response;
    const operation = queue.current.catch(() => {}).then(async () => {
      init?.signal?.throwIfAborted();
      // A queued guest request may have been verified by the preceding one.
      const current = await fetch(url, init);
      if (current.status !== 403) return current;
      const required = await current.clone().json().catch(() => null);
      if (required?.code !== "verification_required" || typeof required.siteKey !== "string" || !["guest", "roblox_signin"].includes(required.action)) return current;
      init?.signal?.throwIfAborted();
      const token = await new Promise<string | null>((resolve) => {
        const aborted = () => finish(null);
        const finish = (value: string | null) => {
          init?.signal?.removeEventListener("abort", aborted);
          setChallenge(null);
          resolve(value);
        };
        init?.signal?.addEventListener("abort", aborted, { once: true });
        setChallenge({ action: required.action, siteKey: required.siteKey, finish });
      });
      init?.signal?.throwIfAborted();
      if (!token) throw new Error("Verification cancelled. Try again.");
      const headers = new Headers(init?.headers);
      headers.set("x-turnstile-token", token);
      // Never automatically replay a failed Siteverify token or a successful mutation.
      return fetch(url, { ...init, headers });
    });
    queue.current = operation;
    return operation;
  }, []);
  return <VerificationContext.Provider value={verifiedFetch}>{children}{challenge && <ChallengeWidget challenge={challenge} />}</VerificationContext.Provider>;
}

export function useVerifiedFetch(): VerifiedFetch {
  const context = useContext(VerificationContext);
  if (!context) throw new Error("VerificationProvider is missing");
  return context;
}
