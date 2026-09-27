"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { prefillAssistant } from "@/components/assistant/prefill";
import type { Insight } from "@/lib/insights/store";
import { Wordmark } from "@/components/wordmark";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
/** While today's insight is being written, check back this often, for up to about five minutes. */
const POLL_MS = 15_000;
const POLL_LIMIT = 20;

const shortDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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
  return (
    // On desktop, Top Playing Now sets the row's height: this card's content doesn't count toward it. Without the
    // chart, containing it would shrink it to the height of the error message.
    <section aria-labelledby="insight-heading" className={`rounded-xl border border-line bg-surface p-5 ${fitRow ? "lg:overflow-y-auto lg:[contain:size]" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="insight-heading" className="flex items-center gap-2 text-sm font-medium">
          <Wordmark className="h-3.5 text-white" />
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
          {/* Clamped to fixed heights, so on desktop the card fits beside Top Playing Now without scrolling. */}
          <h4 className="mt-4 text-xs text-fg-subtle">Recommended</h4>
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
                <p className="mt-0.5 text-xs leading-5 text-fg-muted lg:line-clamp-2">{idea.reason}</p>
              </li>
            ))}
          </ul>

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
