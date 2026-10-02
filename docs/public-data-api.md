# Public JSON data access

Romanum exposes public Roblox observations through GET endpoints for browsing assistants and other HTTP clients. No account, credits, paid model or MCP client is required. Read `/api/public/catalog` for the machine-readable directory, metric definitions, sources and coverage guidance. All paths below are relative to the Romanum instance you are using.

These endpoints use the same public tools and observation cache as MCP. They return the data result directly, rather than an MCP response wrapper. Private connected-game analytics are excluded. Reading an endpoint does not enroll a game in collection or backfill its history.

## Current observations

| Endpoint | Query | Bounds and default |
| --- | --- | --- |
| `/api/public/stats` | `universeIds=994732206,4924922222` | Required comma-separated list of 1–10 positive safe-integer **universe IDs**. |
| `/api/public/charts` | `chart=top-playing-now&limit=10` | Required chart ID; limit 1–50, default 20. |
| `/api/public/market` | `pattern=all` | Optional registered title-pattern ID, default `all`. |
| `/api/public/catalog` | None | Directory, accepted values, definitions and limitations. No data lookup. |

Accepted chart and pattern IDs are listed in the catalog. A universe ID identifies an experience; the numeric ID in a `roblox.com/games/...` URL is a **place ID**. Use the existing search endpoint to resolve a Roblox URL or place ID before querying statistics.

For `/api/public/*`, query integers use decimal digits. Whitespace around comma-separated IDs is accepted. Unknown or repeated parameters, empty supplied values, out-of-range inputs and URLs longer than 2048 characters return **400** before retrieving any data. IDs are deduplicated and sorted by the shared service after the ten-item input bound is checked.

Statistics include `requestedUniverseIds`, `missingUniverseIds` and `games`. Unknown or unavailable values remain null; games not returned are identified by their IDs. Charts preserve their original order and sponsored labels, report `totalAvailable`, and limit only the returned game list. Top Earning is Roblox's ordering without actual revenue figures.

Market summaries deduplicate experiences and exclude sponsored entries across four chart samples. They report `availableCharts`, `unavailableCharts`, `sampleSize`, `samplePlayers`, per-chart `observations`, genre shares and heuristic title patterns. Some charts failing can still yield **200** with explicit partial coverage. If every chart fails, the endpoint returns **503**. Successful empty chart samples remain distinct from unavailable ones.

## Existing search and history

The catalog also identifies the existing public routes; their validation and behavior are unchanged:

- `GET /api/games/search?q=Brookhaven`: search by name (at most 80 characters), Roblox game URL or numeric place ID. A Roblox URL is parsed and resolved through the fixed Roblox APIs; arbitrary submitted URLs are never fetched.
- `GET /api/history/games`: up to 100 games with recorded public observations, ordered by their latest recorded player counts. This is a collection directory, not every Roblox game or a current ranking.
- `GET /api/history?universeId=994732206&days=7`: recorded observations for a positive universe ID over 1–30 days, default one day. Includes availability, requested period, sample count, gaps, observation statuses and nullable metrics.

Recorded history contains only observations gathered since collection began and only where games were sampled. An unavailable database, an unsampled game, a failed collection slot and an observed zero are different states. Never convert a gap into zero or infer activity before the recording period.

## Freshness and citations

`fetchedAt` is Romanum's retrieval time; Roblox's underlying measurement time is not supplied. `expiresAt` is the cache expiry. Search/statistics cache for 60 seconds, charts for 120 seconds and place resolution for one hour. Artwork is retrieved separately and may cache for up to one hour. These caches are process-local and do not create history.

Responses use `Cache-Control: no-store`, while the shared service can reuse an observation. Cache hits preserve its original retrieval and expiry times. Market responses retain each chart's times and report the oldest `fetchedAt`/`expiresAt` across available charts. `assembledAt` is when the summary was assembled, not a new observation time.

Cite the returned source, universe or chart ID, metric, unit and full UTC retrieval date. For history, cite the actual `observedAt` values and coverage. For combined chart summaries, retain per-chart timestamps and name missing charts. A player's current concurrent count is not daily active users; cumulative visits are not unique players. Sample shares do not describe all of Roblox, and titles do not verify gameplay mechanics, demand, sustained growth, actual revenue, retention or demographics.

## Errors and MCP

The new routes return a JSON `error` with **400** for invalid queries and **503** for retrieval failures. Upstream error details are not exposed. Use GET; unsupported methods return **405**. Read coverage fields even after a successful response.

MCP remains an optional, free read-only interface to the same services, with additional development guides and tools. `/mcp` uses Streamable HTTP and requires an MCP client; it is not a GET JSON endpoint. See [the MCP guide](mcp.md) or `/connect/guide`, and `/analytics/data` for the public data guide.
