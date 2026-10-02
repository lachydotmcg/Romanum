"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { prefillAssistant } from "@/components/assistant/prefill";
import type { Insight } from "@/lib/insights/store";
import type { Recommendation } from "@/lib/insights/store";
import { Wordmark } from "@/components/wordmark";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
/** While today's insight is being written, check back this often, for up to about five minutes. */
const POLL_MS = 15_000;
const POLL_LIMIT = 20;

const shortDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const observedTime = (at: string) => new Date(at).toLocaleString("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});
const chartNames = {
  "top-playing-now": "Top Playing Now", "top-trending": "Top Trending",
  "up-and-coming": "Up-and-Coming", "top-earning": "Top Earning",
};

function IdeaEvidence({ idea }: { idea: Recommendation }) {
  if (!idea.evidence || !idea.research) return null;
  const research = idea.research;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <h5 className="font-medium text-fg">{idea.title}</h5>
      <p className="mt-2">Chart observations</p>
      <ul className="mt-1 space-y-2">
        {idea.evidence.map((item) => (
          <li key={`${item.chart}:${item.universeId}`}>
            <a href={`https://www.roblox.com/games/${item.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className={`rounded-sm text-fg hover:underline ${FOCUS}`}>
              {item.name}
            </a>
            <p>{chartNames[item.chart]} · {item.playing.toLocaleString("en-US")} players observed · {item.genre ?? "Genre unlisted"}</p>
            <p>Universe {item.universeId} · Place {item.rootPlaceId}</p>
            <p>Retrieved <time dateTime={item.fetchedAt} title={item.fetchedAt}>{observedTime(item.fetchedAt)}</time></p>
          </li>
        ))}
      </ul>
      <p className="mt-2">Competitor search: {research.status === "complete" ? "bounded searches completed" : `${research.status} coverage`}</p>
      <ul className="mt-1 space-y-1">
        {research.searches.map((search) => (
          <li key={search.query}>
            “{search.query}”: {search.status === "unavailable" ? "unavailable; results unknown" : `${search.resultCount} results`}
            {search.fetchedAt && <> · retrieved <time dateTime={search.fetchedAt} title={search.fetchedAt}>{observedTime(search.fetchedAt)}</time></>}
          </li>
        ))}
      </ul>
      {research.games.length > 0 && (
        <>
          <p className="mt-2">Candidate competitors{research.games.length > 5 ? ` (showing 5 of ${research.games.length})` : ""}</p>
          <ul className="mt-1 space-y-1">
            {research.games.slice(0, 5).map((game) => (
              <li key={game.universeId}>
                <a href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className={`rounded-sm text-fg hover:underline ${FOCUS}`}>{game.name}</a>
                {game.sponsored && " (Sponsored)"}
                {" · "}<time dateTime={game.fetchedAt} title={game.fetchedAt}>{observedTime(game.fetchedAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Today's AI-written briefing: recommended titles from today's Roblox charts, and an indie radar of recent news
 * with links to its sources. Shows the latest one available until today's is ready. `fitRow` matches its desktop
 * height to Top Playing Now beside it; without that chart, it takes its own height.
 */
export function RomanumInsight({ initial, today, connected, fitRow }: { initial: Insight | null; today: string; connected: boolean; fitRow: boolean }) {
  const [insight, setInsight] = useState(initial);
  const current = insight?.day === today;

  useEffect(() => {
    if (current || !connected) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      if (++polls > POLL_LIMIT) window.clearInterval(timer);
      fetch("/api/insights")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { insight?: Insight | null } | null) => {
          if (data?.insight) setInsight(data.insight);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [current, connected]);

  const radar = insight?.content.radar ?? [];
  const materialNotes = insight ? [
    insight.content.recommendations.some((idea) => !idea.proposal)
      ? "Earlier suggestions are unverified." : null,
    insight.content.recommendations.some((idea) => idea.research?.status === "unavailable")
      ? "Competitor search could not run; check similar games before committing to a build." : null,
    insight.content.marketEvidence?.charts.some((chart) => chart.stale)
      ? "Some chart observations were stale when assembled; check current charts before acting on them." : null,
  ].filter(Boolean) : [];
  return (
    // On desktop, Top Playing Now sets the row's height: this card's content doesn't count toward it. Without the
    // chart, containing it would shrink it to the height of the error message.
    <section aria-labelledby="insight-heading" className={`rounded-xl border border-line bg-surface p-5 ${fitRow ? "lg:overflow-y-auto lg:[contain:size]" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="insight-heading" className="flex items-baseline gap-2 text-sm font-medium text-white">
          <Wordmark className="h-3.5" />
          <span>insight</span>
        </h3>
        {insight && <span className="text-xs text-fg-subtle">{current ? "Today" : shortDate(insight.day)}</span>}
      </div>

      {!insight ? (
        <p role="status" className="mt-4 text-sm text-fg-muted">
          {connected ? "Preparing today's insight…" : "Not connected"}
        </p>
      ) : (
        <>
          <h4 className="mt-4 text-xs text-fg-subtle">Ideas to prototype</h4>
          <ul className="mt-2 space-y-2">
            {insight.content.recommendations.map((idea) => (
              <li key={idea.title}>
                {connected ? (
                  // Opens the idea in Ask Romanum, ready to develop.
                  <button
                    type="button"
                    onClick={() => prefillAssistant({ prompt: `Develop ${idea.title} into a full game design.` })}
                    className={`rounded-sm text-left text-sm font-semibold text-fg hover:underline ${FOCUS}`}
                  >
                    {idea.title}
                  </button>
                ) : (
                  <p className="text-sm font-semibold text-fg">{idea.title}</p>
                )}
                <p className="mt-0.5 text-xs leading-5 text-fg-muted">
                  {idea.reason}
                </p>
              </li>
            ))}
          </ul>
          {materialNotes.length > 0 && <p className="mt-2 text-xs leading-5 text-fg-muted">{materialNotes.join(" ")}</p>}
          <details className="mt-3 text-xs leading-5 text-fg-muted">
            <summary className={`cursor-pointer rounded-sm text-fg-subtle ${FOCUS}`}>Evidence and sources</summary>
            <p className="mt-2">AI-generated design proposals need playtesting. Retrieved chart observations appear separately.</p>
            {insight.content.marketEvidence ? (
              <>
                <p className="mt-2">Chart coverage: {insight.content.marketEvidence.charts.filter((chart) => chart.status !== "unavailable").length}/4 retrieved. At most ten non-sponsored games per chart.</p>
                <a href="https://www.roblox.com/charts" target="_blank" rel="noopener noreferrer" className={`rounded-sm text-fg hover:underline ${FOCUS}`}>Roblox charts</a>
                <ul className="mt-1 space-y-1">
                  {insight.content.marketEvidence.charts.map((chart) => (
                    <li key={chart.chart}>
                      {chartNames[chart.chart]}: {chart.status === "unavailable" ? "unavailable; coverage unknown" : chart.status === "empty" ? "no usable games in sample" : `${chart.sampledGames} games sampled`}
                      {chart.fetchedAt && <> · retrieved <time dateTime={chart.fetchedAt} title={chart.fetchedAt}>{observedTime(chart.fetchedAt)}</time></>}
                      {chart.stale && " · expired when assembled"}
                      {chart.expiresAt && <p>Cache expired/expiring <time dateTime={chart.expiresAt} title={chart.expiresAt}>{observedTime(chart.expiresAt)}</time></p>}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">Assembled <time dateTime={insight.content.marketEvidence.assembledAt}>{observedTime(insight.content.marketEvidence.assembledAt)}</time></p>
              </>
            ) : <p className="mt-2">Earlier insight: evidence links and retrieval times were not recorded.</p>}
            <p>Generated <time dateTime={insight.content.generatedAt}>{observedTime(insight.content.generatedAt)}</time></p>
            {insight.content.recommendations.map((idea) => <IdeaEvidence key={idea.title} idea={idea} />)}
            <p className="mt-3">Chart presence does not establish growth or an open genre; names do not verify gameplay. Limited Roblox search matches are candidates. Empty results do not prove novelty. Inspect gameplay before comparing.</p>
          </details>

          {radar.length > 0 && (
            <>
              <h4 className="mt-4 text-xs text-fg-subtle">Indie radar</h4>
              <ul className="mt-1 divide-y divide-line">
                {radar.map((item) => (
                  <li key={item.url} className="py-3 lg:py-1.5">
                    <p className="text-xs text-fg-subtle lg:truncate">
                      {item.kind === "roblox" ? "Roblox" : "Outside Roblox"} · {item.source}
                      {item.published && ` · ${shortDate(item.published)}`}
                    </p>
                    {/* On desktop, one line each: the full headline and why it matters show on hover, and screen readers still read why. */}
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`${item.headline} — ${item.why}`}
                      className={`mt-0.5 flex items-start gap-1 rounded-sm text-sm text-fg hover:underline lg:items-center ${FOCUS}`}
                    >
                      <span className="min-w-0 lg:truncate">{item.headline}</span>
                      <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-white lg:mt-0" aria-hidden="true" />
                    </a>
                    <p className="mt-0.5 text-xs leading-5 text-fg-muted lg:sr-only">{item.why}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
