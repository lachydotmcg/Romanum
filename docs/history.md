# Local history

Romanum now stores public Roblox observations in PostgreSQL. The collector runs independently of page views; the website and MCP read the same persisted history. No observations are generated for dates before collection began.

## Run locally

Use Node 22.18+ (24 recommended). In separate terminals at the repository root:

```sh
npm run history:db
npm run history:watch
npm run dev
```

The first command creates an isolated PostgreSQL cluster on `127.0.0.1:55432`, creates `romanum_local`, and applies migrations. It uses the development-only `embedded-postgres` package and installs no system service. Credentials are randomly generated in `.local/history/connection.json`; data lives in `.local/history/postgres`. Both are ignored by Git and excluded from Next deployment tracing. Never commit or upload that directory.

The watcher collects immediately and then on five-minute UTC boundaries. Closing it stops collection; no operating-system scheduled task or automatic startup is installed. Missing intervals remain gaps. Stop the collector before the database. Data survives stopping and restarting the database. `npm run history:collect` performs one run; a second run in the same five-minute slot skips without fetching or overwriting anything.

`npm run history:migrate` reapplies the migration runner safely. Applied migrations have checksums; change the schema through a new migration rather than editing an applied file.

## What is collected

- Four discovery charts: Top Playing Now, Top Trending, Up-and-Coming and Top Earning, with per-chart retrieval status and timestamps.
- Original chart position, title, genre, current chart player count and sponsored status. Sponsored placements are stored as provenance but excluded from the collection cohort and returned historical rank mappings.
- A deduplicated cohort of up to 300 universes per run, selected by best rank then universe ID across those charts. The cohort may change. Absence from a later cohort is not zero players or proof that a game disappeared.
- Public game statistics fetched separately in batches of ten, with at most three batches in flight: concurrent players, visits, favourites and votes. Invalid or unavailable optional counts become null; invalid concurrent-player counts do not create observations.

These are fresh upstream reads, not the dashboard's cached snapshots. Retrieval time is not Roblox's underlying measurement time. Chart discovery uses the existing `country=all`, `device=computer` source; game statistics use the public games and votes APIs. Neither represents authenticated creator analytics.

## Failure and duplicate handling

Each UTC collection slot has one unique run. Concurrent or repeated collectors cannot write a second run for that slot. A claimed failed or interrupted slot is retained rather than backfilled with later observations masquerading as earlier data. The next slot can still collect normally.

Writes for chart snapshots and statistics batches are transactional. A failed chart does not discard successful charts. Missing IDs and failed statistic requests mark their targets unavailable. A crash can leave a run marked running; the reader treats unobserved targets in such a run as unavailable. Completed batches retain their actual observations. Database outages cannot themselves be recorded until the database is reachable; absent slots become missed intervals in queries.

## Queries and graphs

- `GET /api/history/games`: up to 100 games with stored observations, ordered by their latest recorded player count.
- `GET /api/history?universeId=123&days=1`: 1–30 days of recorded observations and explicit gaps.
- MCP / assistant tool `get_game_history`: the same query with numeric `universeId` and optional `days`.

Queries use bound SQL parameters and return at most one point per five-minute slot (at most 8,641 points for 30 days). An unknown game returns an empty history. With no database configured, the API returns `available:false` and empty data; a configured but unreachable database returns a concise error.

Point statuses:

| Status | Meaning |
| --- | --- |
| `observed` | An actual game-statistics observation; `observedAt` is retrieval time. Zero is retained when Roblox actually reports zero. |
| `unavailable` | A requested observation failed, was omitted, or the run failed/interrupted. |
| `not_sampled` | The game was outside this run's selected cohort. |
| `missed` | No collector run exists for this elapsed slot. |

For gap points, `observedAt` is the expected slot time and every numeric metric is null. No current, unstarted slot is prematurely labelled missed. Historical chart ranks are separate chart observations, not rankings derived from the game-statistics counts.

The Player history panel draws a straight line only after two actual observations exist, breaks it at null points and retains isolated markers. It offers exact values in a paginated UTC table. A short history does not establish sustained growth, and counts do not reveal retention, revenue or demographics. The assistant may retrieve history but its existing chart tool remains restricted to current comparisons.

## Tests and deployment boundary

`npm test` uses PGlite (the PostgreSQL engine compiled to WASM) in isolated, disposable memory databases for migration, transaction, idempotency, failure, cohort and gap tests. Test fixtures never enter the app database. The actual local pipeline uses native PostgreSQL through `pg`. `npm run mcp:smoke` additionally checks the live history tool through the official client.

Production requires `DATABASE_URL`; the `.local` fallback is development-only. Migration and collector commands default to the local database even when a shell has `DATABASE_URL`. Use the explicit `--configured` flag to target that variable after choosing and configuring a deployment. No hosted database has been created or modified.

Before public deployment, separate database read/write roles, schedule collection in a managed worker, configure backups and retention, and apply shared limits to the history API. Five-minute collection of 300 games can create 86,400 game observations per day, plus chart entries; storage and query costs must be sized accordingly. Local credentials and the development database launcher are not production infrastructure.
