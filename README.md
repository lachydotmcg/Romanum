# Romanum

Create without limits.

Romanum is a Roblox developer platform bringing together public analytics, genre and pattern research, and an AI assistant for game ideas and design.

[PROJECT.md](PROJECT.md) records the complete product outline and eight-stage roadmap. **Stage 1 — Foundation is the current priority.** Later stages are direction, not implementation requests. [Implementation status](docs/roadmap.md) describes what already exists.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The root redirects to `/analytics`.

Use Node.js 22.18+ (Node 24 recommended). `npm test` runs the data and skill tests using Node's built-in TypeScript support. `npm run lint`, `npx tsc --noEmit`, and `npm run build` check the application.

## MCP

The first public, read-only MCP slice is implemented under the owner's separate authorization. Open **Get MCP** for the connection URL; local clients connect to `http://localhost:3000/mcp` over Streamable HTTP. Eight tools expose search, public stats, recorded history, game links, charts, market summaries, guides and metric definitions. No model API key is needed. There is no public deployment yet.

Run `npm run mcp:smoke` while the app is running to test the official client against real Roblox data. [Setup and deployment documentation](docs/mcp.md) is also available at `/connect/guide`. The endpoint shares observations, schemas and handlers with the website and assistant; process-local caching, request/body limits and host/origin validation are included.

## AI assistant

The prompt bar at the top of Analytics is an assistant that answers from public Roblox data (live players, visits, favourites, likes, genre, creator and dates) and Roblox's own charts. While it works, a single status line shows what it's doing ("Searching for "Blox Fruits"…"); expand it to see every step, including the exact input and raw result of each lookup.

It can draw charts in the chat: bar, column, stacked bar, donut, treemap, scatter, radar and stat tiles. It chooses the form, colours, sorting and scale, but never the numbers: the server fills every value in from data the tools fetched, and refuses anything that wasn't fetched. Every chart has a table view.

It runs on DeepSeek (`deepseek-flash`). Add a key to `.env.local`, which git ignores:

```bash
DEEPSEEK_API_KEY=your-key
```

Without a key the prompt bar shows as not connected.

Provider failures show a short error in the UI. Server logs contain the error name and status: check `DEEPSEEK_API_KEY` for authentication failures, account credit for HTTP 402, and provider rate limits for HTTP 429.

- `src/app/api/assistant/route.ts`: the model loop, streamed to the browser as one JSON event per line
- `src/lib/assistant/tools.ts`: adapts the shared public tools and assistant-only chart rendering for the model
- `src/lib/public-tools.ts`: validated schemas and handlers shared with MCP
- `src/lib/public-data.ts`: shared cached observations, sources and retrieval timestamps
- `src/lib/assistant/chart-tool.ts`: validates chart requests and resolves their values from fetched data
- `src/lib/roblox.ts`: the public Roblox endpoints (game search and Roblox's charts use undocumented endpoints behind roblox.com)

The paid assistant endpoint has no sign-in or rate limiting yet, so don't deploy that route publicly as is: anyone could spend the DeepSeek credit. These restrictions are separate from the read-only MCP server, which does not invoke DeepSeek.

## Charts

`src/lib/charts/` holds the chart spec, the colour palette and the ECharts options; `src/components/charts/` renders them. Single-series linear rankings use game artwork and slim proportional bars, while complex charts use ECharts. Scatter and radar charts are limited to the palette's first three colours.

Player history now plots observations recorded by Romanum's local PostgreSQL collector. It shows no invented or backfilled history, requires two actual observations for a line, and preserves gaps. Start `npm run history:db` and `npm run history:watch` in separate terminals; see [local history](docs/history.md). Hosting and production collection are still pending.

"Roblox right now" on Analytics shows Roblox's Top Playing Now, Top Trending, Up-and-Coming and Top Earning charts, cached for two minutes. Top Earning is Roblox's ranking only; revenue figures aren't public.

Icons come from Roblox's public thumbnails API, batched by universe ID and cached for an hour. Missing, blocked or failed icons fall back to a game symbol without breaking the stats. Lists and chart rows link to each game's Roblox page. The revised hierarchy takes inspiration from [RoTrends](https://www.rotrends.com/); Romanum fetches its own data from Roblox.

## Genres and patterns

The pattern explorer groups title matches for **Steal a…**, **+1 incrementals**, **Grow a…**, **Brainrot**, **Escape & obby**, and **Pets & eggs** across the four charts. It excludes sponsored entries and deduplicates universes before calculating current players, median players per game, the largest game's share, and presence in Up-and-Coming. The genre breakdown uses the Top Playing Now sample only; the pattern explorer uses the union of loaded charts.

These are current snapshot signals, not measured growth or verified gameplay mechanics. Patterns overlap; the chart sample is not all of Roblox, and a title match count is not a saturation score. Individual chart cards report load failures. See [data notes](docs/data-notes.md) for methodology and limitations, and [the roadmap](docs/roadmap.md) for historical collection, broader classification and first-party analytics.

## Reusable assistant skills

The same Markdown guides are used by the platform and distributed from this repository:

- [Genre analysis](skills/romanum-genre-analysis/SKILL.md): evidence, concentration, comparisons and limits of public chart data.
- [Game design](skills/romanum-game-design/SKILL.md): differentiated ideas, core loops, age-appropriate onboarding and prototype tests.

The Skills section is temporarily hidden: its navigation entry is removed and `/skills` plus its guide pages redirect to Analytics. The repository guides, download endpoints and internal assistant support remain available. The assistant chooses the relevant skill automatically; **Develop an idea** prepares an editable prompt without submitting it.

To use a guide in another agent, copy the corresponding folder under `skills/` into that agent's supported skill directory. Each guide is self-contained. A Markdown skill does not install live Roblox tools: outside Romanum, supply a connector or a dated data export. No separate repository is required; these folders can be extracted later without changing the skill format.

`src/lib/assistant/skills.ts` reads only registered guide files, with deployment file tracing configured in `next.config.ts`. `get_market_analysis` provides the same aggregation used by the dashboard. `load_skill` supplies guides on demand, based on the user's question; there is no manual skill mode.

Tizzy RBLX is a planned knowledge source. The checked videos did not expose transcripts, so **no teaching has been attributed or incorporated yet**. [Source status and ingestion notes](docs/knowledge-sources.md) describe how to add timestamped, attributed summaries when transcripts are supplied.

## Brand assets

- `public/brand/romanum-wordmark.svg`: full wordmark, white, for dark backgrounds
- `public/brand/romanum-wordmark-compact.svg`: compact "Ro" form
- `src/app/icon.svg`: the tilted-square symbol, used as the favicon
- `src/components/wordmark.tsx`: the wordmark as a React component (uses `currentColor`)
- `src/components/skills-mark.tsx`: the custom Skills SVG, with offset building blocks around Romanum's tilted square

Letterforms are Outfit Bold (SIL Open Font License 1.1) converted to outlines. The "o" is a custom tilted square with a central cutout.
