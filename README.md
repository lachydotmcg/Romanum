# Romanum

Create without limits.

A Roblox development platform with public game search, current statistics, recorded player history, an AI assistant and a free read-only MCP server.

- **[Browse the skills](skills/README.md)** — reusable research, game design, onboarding and thumbnail guides.
- **[Connect through MCP](docs/mcp.md)** — use the same public data from an external agent.

## Local development

Use Node.js 22.18 or newer (24 recommended).

```sh
npm install
npm run dev
```

Open http://localhost:3000. To collect public observations locally, run `npm run history:db` and `npm run history:watch` in separate terminals. Data stays under the ignored `.local/` directory. Collection lasts only while those processes run. Viewing a game does not enrol it in collection.

The integrated assistant uses `DEEPSEEK_API_KEY` in `.env.local`. Public analytics and MCP do not require a paid model. The assistant needs authentication and spending controls before public deployment.

## Current boundaries

Charts use actual observations and preserve collection gaps. Public data does not reveal private retention, revenue, demographic or thumbnail CTR metrics. Idea research finds candidate competitors; it does not certify originality or compare gameplay quality.

The credit ledger is a tested server-side foundation, with reservations, settlement and release. There is no payment checkout, public credit API or paid image generation enabled.

## Checks

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run mcp:smoke
```

The MCP smoke test requires a running local application and contacts Roblox. Unit tests use isolated fixtures. Application schemas live in `db/migrations`; the local database launcher applies them in order.

## Repository

`src/app` contains routes, `src/lib` shared services, `skills` the portable guides, and `tests` contract and storage checks. Internal planning and raw third-party transcripts are not distributed.
