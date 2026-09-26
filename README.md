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

The credit ledger supports reservations, settlement and release. Private creation services save project context, briefs, concepts, review decisions and image jobs. UI assets follow an approved render; thumbnail references keep rights and reported performance separate. The OpenAI adapter is disabled by default, and the job runner rejects all paid providers. There is no checkout, public creation API or paid image generation enabled.

Creation code lives in `src/lib/creative`. It currently runs through trusted server calls and isolated tests. Test tariffs are arbitrary credit units, not prices. Jobs with ambiguous provider outcomes keep their reservation and require reconciliation; they are never retried automatically. Production needs authenticated owner identity, image decoding/moderation, private object storage, pricing and receipt reconciliation before these services can be exposed.

`src/lib/ui-library` provides private UI drafts, bounded search of explicitly shared entries, reuse into projects, and static Roblox UI export. Sharing needs a separate rights declaration and versioned consent to CC BY 4.0. Withdrawal removes related listings; listing deletion scrubs its content while private project assets and previously licensed copies remain separate. No marketplace is publicly enabled or seeded with third-party packs.

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

## Licence

Romanum's code and skills use the custom [Romanum Source-Available License](LICENSE). Commercializing the code, hosted copies, or skill packs requires separate permission. You may use the tools and skills to create and monetize your own games, images, UI assets and client work. Third-party rights still apply. See [third-party notices](THIRD_PARTY_NOTICES.md).
