"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { GameIcon } from "@/components/game-icon";
import { Switch } from "@/components/switch";
import { formatMetric } from "@/lib/linked-games/metrics";
import type { LinkedGameView } from "@/lib/linked-games/view";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const INPUT = `min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong ${FOCUS}`;
const KEYS_PAGE = "https://create.roblox.com/dashboard/credentials?activeTab=ApiKeysTab";
/** The metrics each game's card shows, labelled to fit its tiles; its game page shows them all. */
const SUMMARY = [
  { metric: "DailyActiveUsers", label: "DAU" },
  { metric: "AveragePlayTimeMinutesPerDAU", label: "Playtime" },
  { metric: "ForwardD1Retention", label: "Day 1 retention" },
  { metric: "DailyRevenue", label: "Revenue" },
];
/** While a game syncs, check back this often, for up to about two minutes. */
const POLL_MS = 5_000;
const POLL_LIMIT = 24;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function statusLine(game: LinkedGameView): string {
  if (game.status === "key_rejected") return game.syncError ?? "Roblox rejected the key. Link the game again with a new key.";
  if (game.status === "disconnected") return "Disconnected. Link the game again to resume.";
  if (!game.collect) return "Collection off";
  if (game.syncing) return "Syncing…";
  if (game.syncError) return game.syncError;
  return game.syncedAt ? `Synced ${ago(game.syncedAt)}` : "Waiting to sync";
}

const needsPolling = (games: LinkedGameView[]) =>
  games.some((game) => game.syncing || (game.status === "active" && game.collect && !game.syncedAt && !game.syncError));

async function send(url: string, init: RequestInit): Promise<{ game?: LinkedGameView; error?: string }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => null);
  return res.ok ? { game: data?.game } : { error: typeof data?.error === "string" ? data.error : "Something went wrong. Try again." };
}

function GameCard({ game, onChange, onRemove, onRelink }: { game: LinkedGameView; onChange: (game: LinkedGameView) => void; onRemove: () => void; onRelink: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = game.name ?? `Universe ${game.universeId}`;
  const hasKey = game.status !== "disconnected";

  async function act(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    const result = await send(url, init).catch(() => ({ error: "Couldn't reach Romanum. Try again." }) as { game?: LinkedGameView; error?: string });
    setBusy(false);
    if (result.error) setError(result.error);
    return result;
  }

  async function toggle(setting: "collect" | "share", value: boolean) {
    const { game: updated } = await act(`/api/linked-games/${game.id}`, { method: "PATCH", body: JSON.stringify({ [setting]: value }) });
    if (updated) onChange(updated);
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${name}? Romanum deletes its copy of the key and stops syncing. The metrics stay until you delete them.`)) return;
    const { game: updated } = await act(`/api/linked-games/${game.id}/disconnect`, { method: "POST" });
    if (updated) onChange(updated);
  }

  async function remove() {
    if (!window.confirm(`Delete ${name} from Romanum? This deletes its key and all its synced metrics.`)) return;
    const result = await act(`/api/linked-games/${game.id}`, { method: "DELETE" });
    if (!result.error) onRemove();
  }

  const summary = SUMMARY.flatMap(({ metric, label }) => {
    const found = game.metrics.find((item) => item.metric === metric);
    return found ? [{ ...found, label }] : [];
  });
  return (
    <li className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <GameIcon url={game.iconUrl} name={name} className="size-12" />
        <div className="min-w-0 flex-1">
          <Link href={`/analytics/games/${game.universeId}#your-analytics`} prefetch={false} className={`inline-flex items-center gap-1 rounded-sm text-sm font-medium text-fg hover:underline ${FOCUS}`}>
            <span className="truncate">{name}</span>
          </Link>
          <p className="mt-0.5 text-xs text-fg-muted" role="status">
            {statusLine(game)}
            {game.keyHint && <span className="text-fg-subtle"> · Key …{game.keyHint}</span>}
          </p>
        </div>
      </div>

      {summary.some((metric) => metric.latest) && (
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summary.map((metric) => (
            <div key={metric.metric} className="rounded-lg border border-line px-3 py-2.5">
              <dt className="truncate text-xs text-fg-muted">{metric.label}</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums" title={metric.latest ? metric.latest.day : undefined}>
                {formatMetric(metric.unit === "rate" && metric.latest && metric.latest.value > 1 ? metric.latest.value / 100 : metric.latest?.value, metric.unit)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <Switch
          label="Collect analytics"
          description="Sync this game's daily metrics from Roblox with your key. Only you can see them."
          checked={game.collect}
          disabled={busy || game.status !== "active"}
          onChange={(value) => toggle("collect", value)}
        />
        <Switch
          label="Help improve Romanum"
          description="Let Romanum use this game's daily metrics, from today on, to improve its analysis."
          checked={game.share}
          disabled={busy}
          onChange={(value) => toggle("share", value)}
        />
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-fg">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {game.status !== "active" && (
          <button type="button" onClick={onRelink} className={`min-h-9 rounded-lg border border-line px-3 text-xs text-fg hover:bg-surface-hover ${FOCUS}`}>
            Link again
          </button>
        )}
        {hasKey && (
          <button type="button" disabled={busy} onClick={disconnect} className={`min-h-9 rounded-lg border border-line px-3 text-xs text-fg hover:bg-surface-hover disabled:opacity-50 ${FOCUS}`}>
            Disconnect
          </button>
        )}
        <button type="button" disabled={busy} onClick={remove} className={`min-h-9 rounded-lg px-3 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50 ${FOCUS}`}>
          Delete data
        </button>
      </div>
    </li>
  );
}

/** The signed-in account's linked games, and the form that links another with its Open Cloud API key. */
export function LinkedGames({ initial }: { initial: LinkedGameView[] }) {
  const [games, setGames] = useState(initial);
  const [universeId, setUniverseId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idField = useRef<HTMLInputElement>(null);
  const polling = needsPolling(games);

  useEffect(() => {
    if (!polling) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      if (++polls > POLL_LIMIT) return window.clearInterval(timer);
      fetch("/api/linked-games")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { games?: LinkedGameView[] } | null) => {
          if (Array.isArray(data?.games)) setGames(data.games);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling]);

  async function link(event: React.FormEvent) {
    event.preventDefault();
    setLinking(true);
    setError(null);
    const result = await send("/api/linked-games", { method: "POST", body: JSON.stringify({ universeId, apiKey }) }).catch(() => ({
      error: "Couldn't reach Romanum. Try again.",
    }) as { game?: LinkedGameView; error?: string });
    setLinking(false);
    if (result.error || !result.game) return setError(result.error ?? "Something went wrong. Try again.");
    const linked = result.game;
    setGames((list) => [...list.filter((game) => game.id !== linked.id), linked]);
    setUniverseId("");
    setApiKey("");
  }

  function relink(game: LinkedGameView) {
    setUniverseId(String(game.universeId));
    setApiKey("");
    idField.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    idField.current?.form?.querySelector<HTMLInputElement>("input[name=apiKey]")?.focus();
  }

  return (
    <>
      {games.length > 0 ? (
        <ul className="mt-4 grid gap-4 lg:grid-cols-2">
          {games.map((game) => (
            <GameCard
              key={game.id}
              game={game}
              onChange={(updated) => setGames((list) => list.map((item) => (item.id === updated.id ? updated : item)))}
              onRemove={() => setGames((list) => list.filter((item) => item.id !== game.id))}
              onRelink={() => relink(game)}
            />
          ))}
        </ul>
      ) : (
        <div className="mt-4 grid min-h-24 place-items-center rounded-xl border border-line px-6 py-6 text-center">
          <p className="text-sm text-fg-muted">No games linked</p>
        </div>
      )}

      <form onSubmit={link} className="mt-6 max-w-2xl rounded-xl border border-line p-5" aria-labelledby="link-game-heading">
        <h3 id="link-game-heading" className="text-sm font-medium">
          Link a game
        </h3>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          Create an API key with <span className="text-fg">universe-analytics</span> → <span className="text-fg">universe.analytics:read</span> for the game.
          Romanum encrypts the key and never shows it again. It syncs daily active users, sessions, playtime, retention, revenue and payer conversion.{" "}
          <a href={KEYS_PAGE} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-0.5 rounded-sm text-fg underline-offset-2 hover:underline ${FOCUS}`}>
            Creator Dashboard <ArrowUpRight className="size-3 text-white" aria-hidden="true" />
          </a>
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <label className="block">
            <span className="text-xs text-fg-muted">Universe ID</span>
            <input
              ref={idField}
              name="universeId"
              value={universeId}
              onChange={(event) => setUniverseId(event.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="off"
              maxLength={16}
              required
              className={`mt-1 ${INPUT}`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-fg-muted">API key</span>
            <input
              name="apiKey"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              required
              className={`mt-1 ${INPUT}`}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-fg">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={linking || !universeId || !apiKey.trim()}
          className={`mt-4 min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-subtle ${FOCUS}`}
        >
          {linking ? "Checking the key…" : "Link game"}
        </button>
      </form>
    </>
  );
}
