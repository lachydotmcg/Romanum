# Implementation status and deferred analytics notes

The complete product outline and eight-stage roadmap live in [PROJECT.md](../PROJECT.md). **Stage 1 — Foundation is the current priority.** This file records existing code and preserves technical notes for later stages; it does not authorize their implementation or mark those stages complete.

## Available now

- SVG branding, the dark application shell and the animated `Ro` to `Romanum` sidebar.
- ChatGPT-style sidebar control: on the collapsed rail, hovering the `Ro` logo turns it into the open button (tapping it opens the rail on touch); expanded, the close button sits at the right. Collapsed icons have tooltips; Escape, an outside click or navigating closes the rail. Skip-to-content link.
- Theme modelled on ChatGPT's dark mode: pure black canvas, `#1b1b1b` surfaces, `#262626` borders; the sidebar stays one step lighter. The content area is up to 1600px wide; chat prose keeps a readable line length.
- Concise chart retry actions, an Analytics error boundary and an application-styled missing-page state. The MCP URL field retains its height on narrow screens.
- Navigation: Analytics, plus Your games as a shortcut to the profile (`/profile`), where games will live. The profile is the Guest with "No games connected"; the Guest row also opens it. Get MCP links to the connection page.
- Assistant answers are short by default and offer more detail. After each answer, a separate small DeepSeek call predicts the next question; the prompt bar shows it and Tab (or the Tab badge) fills it in.
- A public, read-only Streamable HTTP MCP endpoint at `/mcp`, with eight tools and three resources over the shared data service. The owner explicitly authorized this slice on 2026-09-26. It is verified locally; no public deployment is configured. See [MCP setup](mcp.md).
- Public game icons in ranked lists, comparison charts, stat tiles and chart tables.
- Search by game name, Roblox game link or numeric place ID within Analytics. Results and discovery lists open `/analytics/games/[universeId]`, with current public stats, icons and per-game recorded history. These use the same observations as MCP; opening a game does not add it to the collector cohort. See [game discovery](game-discovery.md).
- Four current Roblox chart samples with deduplicated, non-sponsored genre/pattern analysis.
- Title-pattern leads for Steal a, +1 incrementals, Grow a, Brainrot, Escape & obby and Pets & eggs. These are heuristic labels, not verified mechanics.
- Current players, median per game, largest-game share and presence in discovery charts.
- A pattern-to-idea handoff and portable skills used by the in-platform assistant.
- The Skills section is temporarily hidden. Its pages redirect to Analytics; repository guides, downloads, internal support and the custom SVG are preserved.

The dashboard integrations preceded the full roadmap; MCP and local history were authorized afterward. These capabilities do not imply a hosted data platform, verified market-wide trends, private analytics or completion of later stages.

## Local Stage 2: observation history

The owner authorized local implementation on 2026-09-26. PostgreSQL now stores collection runs, chart snapshots, selected cohorts and public game observations. A five-minute collector uses fresh requests, prevents duplicate slots and preserves failures. The website Player history panel and MCP `get_game_history` tool share the same persisted queries. Graphs require actual recorded samples and break at gaps. Setup and limitations are in [local history](history.md).

## Deferred: broader measured trends — Stage 2

Deploy the collector and database with backups, retention and shared limits. Gather enough history to compare consistent windows and account for time-of-day patterns before adding velocity, persistence and market-wide trend claims. Expand cohort tracking beyond the initial discovery sample.

## Deferred: stronger classification — Stage 2

Expand beyond fixed title rules: group variants, distinguish theme from mechanic, and confirm with game descriptions and human-reviewed gameplay evidence. Keep a versioned taxonomy and a way to correct matches. Measure concentration across a broader population before discussing saturation or opportunity rankings.

## Deferred: sourced design knowledge — Stage 3

Integrate reviewed creator transcript notes with timestamps and attribution; see `knowledge-sources.md`. Keep gameplay advice distinct from market measurements. Use the guides to produce differentiated core loops, practical prototype plans and testable onboarding hypotheses.

## Deferred: first-party validation — Stage 4

Connect developer-owned data for retention, onboarding, engagement and monetization measurements. Public current-player counts cannot substitute for these. Add authentication and rate limiting before exposing the paid assistant publicly.

The owner requested API-key connections, optional platform-improvement sharing, disclosure and future deletion requests on 2026-09-26. The [connected-data plan](connected-data.md) separates these requirements from proposed consent defaults, security design, retention decisions and release gates. None of this private ingestion or sharing is implemented yet.
