# Data notes

Keep these implementation notes out of the dashboard's routine UI copy. Retain metric names, units and concise load failures in the interface.

## Sources and coverage

- The dashboard uses public Roblox charts, cached for up to two minutes. Icons use the public thumbnails API and are cached for an hour.
- Genre shares use Roblox's genre labels in the non-sponsored Top Playing Now sample. They are not totals for all of Roblox. The displayed game count identifies the size of that sample.
- Patterns use the union of the four loaded charts, deduplicated by universe ID and excluding sponsored placements. Failed charts are omitted from the analysis; their individual cards show a load error.
- Top Earning is Roblox's own ranking. Public revenue figures are not available.

The dashboard, assistant and MCP share the bounded, process-local observation cache in `public-data.ts`. Search/statistics cache for 60 seconds, charts for 120 seconds and place mappings for one hour; concurrent identical requests share a fetch. Failures are not cached. Retrieval and expiry timestamps belong to the cached observation, so cache hits never claim a new fetch. These timestamps do not identify Roblox's underlying measurement time. Processes/replicas have separate caches; none of this creates durable history.

The MCP market tool includes per-chart retrieval times and failed-chart coverage. Its genre totals use the union of loaded charts; the dashboard's genre card deliberately uses Top Playing Now only. [Metric definitions](mcp.md#data-interpretation) are exposed to agents as both a tool and a resource.

## Pattern metrics

Patterns match words in titles, not verified gameplay mechanics, and can overlap. No matches means none were found in the loaded sample, not that no such games exist elsewhere.

Players and median players per game describe current scale. Leader share is the largest matching game's fraction of the pattern's players: a high share indicates concentration in one hit. Up-and-Coming counts matching games on that Roblox chart.

These measurements cannot establish growth, retention, audience demographics, market-wide saturation or demand for another game. A suggested game idea is a hypothesis to test, not a guaranteed opportunity.

## Charts

Romanum's local collector now records public snapshots in PostgreSQL. The Player history panel reads these observations only, draws no line before two samples exist, and breaks at null gaps. Snapshot pattern analysis still describes the current sample, not measured market-wide trends. See [local history](history.md) for collection and coverage rules. Radar axes are normalized relative to the highest value shown on each axis; the table contains the original values.

## Skills and creator sources

The assistant selects guides automatically. The Skills section is temporarily hidden; its index and guide URLs redirect to Analytics. Guides remain in the repository, with installation instructions in the [README](../README.md#reusable-assistant-skills). Creator transcript availability and attribution are tracked in [knowledge sources](knowledge-sources.md).
