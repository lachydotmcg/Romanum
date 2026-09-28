"use client";

import { useState } from "react";
import Link from "next/link";
import { RobloxLogo } from "./roblox-logo";
import { useVerifiedFetch } from "../verification";

export function SignInButton() {
  const request = useVerifiedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const response = await request("/auth/roblox", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Couldn't sign in. Try again.");
      window.location.assign(data.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <button type="button" disabled={busy} onClick={signIn} className="inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg bg-fg px-4 text-sm font-medium text-canvas outline-offset-2 hover:bg-white focus-visible:outline-2 focus-visible:outline-fg/70 disabled:opacity-50">
        <RobloxLogo className="size-5 shrink-0" />{busy ? "Signing in…" : "Sign in with Roblox"}
      </button>
      <Link href="/privacy#collection" className="text-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline">Privacy policy</Link>
      {error && <p role="alert" className="max-w-xs text-sm text-fg-muted">{error}</p>}
    </div>
  );
}
