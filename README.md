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

The prompt bar at the top of Analytics is an assistant that answers from public Roblox data (live players, visits, favourites, likes, genre, creator and dates). Each lookup it makes is shown in the chat as it happens, and can be expanded to see the exact input and the raw result.

It runs on DeepSeek (`deepseek-flash`). Add a key to `.env.local`, which git ignores:

```bash
DEEPSEEK_API_KEY=your-key
```

Without a key the prompt bar shows as not connected.

- `src/app/api/assistant/route.ts`: the model loop, streamed to the browser as one JSON event per line
- `src/lib/assistant/tools.ts`: the tools the model can call
- `src/lib/roblox.ts`: the public Roblox endpoints (game search uses the undocumented endpoint behind roblox.com's search box)

The endpoint has no sign-in or rate limiting yet, so don't deploy it publicly as is: anyone could spend the DeepSeek credit.

## Brand assets

- `public/brand/romanum-wordmark.svg`: full wordmark, white, for dark backgrounds
- `public/brand/romanum-wordmark-compact.svg`: compact "Ro" form
- `src/app/icon.svg`: the tilted-square symbol, used as the favicon
- `src/components/wordmark.tsx`: the wordmark as a React component (uses `currentColor`)

Letterforms are Outfit Bold (SIL Open Font License 1.1) converted to outlines. The "o" is a custom tilted square with a central cutout.
