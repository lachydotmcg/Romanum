# Game discovery

The owner authorised this public Stage 2 slice on 2026-09-26. It adds search inside Analytics and individual pages at `/analytics/games/[universeId]`; no navigation section, account system or private data ingestion is introduced.

## Data path

`GET /api/games/search?q=...` accepts a name (1–80 characters), a Roblox game URL (up to 300 characters), or a numeric **place ID**. Names use `publicData.search`; links are parsed into a place ID, resolved through `publicData.resolve`, then loaded with `publicData.stats`. Arbitrary submitted URLs are never fetched. Page routes use **universe IDs**, with positive safe-integer validation before any upstream request.

These are the same operations and cache entries used by MCP `search_games`, `resolve_game_link` and `get_game_stats`. Search/stats observations retain their original retrieval timestamps for the 60-second process-local cache window. No new MCP tool is needed. Search uses the existing undocumented Roblox web search endpoint; it may change or fail independently of Romanum. Sponsored placements are labelled in search results.

Game pages display actual public statistics and creator/genre/date metadata. An absent game returns a missing-game state; request failures offer Retry. A missing metric stays unknown rather than becoming zero. History uses the existing `get_game_history` service through `/api/history`, including null gaps and honest empty states. A game page does not enrol a game in collection or backfill history. The collector's cohort is documented in [history.md](history.md).

The search runs on submission, cancels obsolete requests and stores the submitted query in the page URL for navigation back to results. Game links do not prefetch every page's stats. External Roblox links remain available on game pages.

## Verification

Unit tests cover shared observations with MCP, place-to-universe resolution, invalid IDs/URLs, preserved zero counts, missing games and upstream failures. Browser checks cover search, result navigation, history, narrow layouts and missing-game states. Run the repository checks and the existing live MCP smoke test for shared-service changes.

Public deployment still needs shared rate/concurrency limits at the application boundary, as recorded for MCP. This change does not deploy the site or change data collection/retention.
