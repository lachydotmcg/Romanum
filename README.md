# Romanum

Create without limits.

Romanum is a Roblox developer platform bringing together free analytics, data-informed AI assistance and game creation tools. This repository currently holds the site's interface and branding (stage 1).

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The root redirects to `/analytics`.

## AI assistant

The prompt bar at the top of Analytics is an assistant that answers from public Roblox data (live players, visits, favourites, likes, genre, creator and dates) and Roblox's own charts. While it works, a single status line shows what it's doing ("Searching for "Blox Fruits"…"); expand it to see every step, including the exact input and raw result of each lookup.

It can draw charts in the chat: bar, column, stacked bar, donut, treemap, scatter, radar and stat tiles. It chooses the form, colours, sorting and scale, but never the numbers: the server fills every value in from data the tools fetched, and refuses anything that wasn't fetched. Every chart has a table view.

It runs on DeepSeek (`deepseek-flash`). Add a key to `.env.local`, which git ignores:

```bash
DEEPSEEK_API_KEY=your-key
```

Without a key the prompt bar shows as not connected.

- `src/app/api/assistant/route.ts`: the model loop, streamed to the browser as one JSON event per line
- `src/lib/assistant/tools.ts`: the tools the model can call
- `src/lib/assistant/chart-tool.ts`: validates chart requests and resolves their values from fetched data
- `src/lib/roblox.ts`: the public Roblox endpoints (game search and Roblox's charts use undocumented endpoints behind roblox.com)

The endpoint has no sign-in or rate limiting yet, so don't deploy it publicly as is: anyone could spend the DeepSeek credit.

## Charts

`src/lib/charts/` holds the chart spec, the colour palette and the ECharts options; `src/components/charts/` renders them. The eight-colour palette is validated for colour-vision deficiency on Romanum's surfaces, and scatter and radar charts are limited to its first three colours.

Line charts are supported by the renderer, but nothing feeds them yet: Roblox's public data has no history, so line charts need Romanum to record snapshots over time.

"Roblox right now" on Analytics shows Roblox's Top Playing Now, Top Trending, Up-and-Coming and Top Earning charts, cached for two minutes. Top Earning is Roblox's ranking only; revenue figures aren't public.

## Brand assets

- `public/brand/romanum-wordmark.svg`: full wordmark, white, for dark backgrounds
- `public/brand/romanum-wordmark-compact.svg`: compact "Ro" form
- `src/app/icon.svg`: the tilted-square symbol, used as the favicon
- `src/components/wordmark.tsx`: the wordmark as a React component (uses `currentColor`)

Letterforms are Outfit Bold (SIL Open Font License 1.1) converted to outlines. The "o" is a custom tilted square with a central cutout.
