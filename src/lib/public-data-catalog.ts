import { METRIC_DEFINITIONS } from "./metric-definitions.ts";
import { PATTERNS } from "./market-analysis.ts";
import { ROBLOX_CHART_IDS } from "./roblox.ts";
import { HISTORY_COMPARISON_POLICY } from "./analytics/history-comparison.ts";

/** Relative URLs work on the same origin as this catalog; no private identity or live lookup is needed. */
export const PUBLIC_DATA_CATALOG = {
  version: "2",
  access: { method: "GET", readOnly: true, authenticationRequired: false, creditsRequired: false, modelRequired: false },
  endpoints: [
    {
      path: "/api/public/stats", description: "Current public Roblox game statistics and metadata.",
      parameters: { universeIds: { required: true, encoding: "comma-separated positive safe-integer universe IDs", minItems: 1, maxItems: 10 } },
      example: "/api/public/stats?universeIds=994732206,4924922222",
      cacheWindowSeconds: 60,
      response: "Source, fetchedAt, expiresAt, requestedUniverseIds, missingUniverseIds and games. Missing values remain null; an empty result is not zero activity.",
    },
    {
      path: "/api/public/charts", description: "One current Roblox chart, preserving its order and sponsored labels.",
      parameters: {
        chart: { required: true, values: ROBLOX_CHART_IDS },
        limit: { required: false, type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      example: "/api/public/charts?chart=top-playing-now&limit=10",
      cacheWindowSeconds: 120,
      response: "Source, fetchedAt, expiresAt, chartId, chart, totalAvailable and games. Top Earning is a ranking without revenue figures.",
    },
    {
      path: "/api/public/market", description: "Deduplicated, non-sponsored genre and title-pattern summaries across four chart samples.",
      parameters: { pattern: { required: false, values: ["all", ...PATTERNS.map(pattern => pattern.id)], default: "all" } },
      example: "/api/public/market?pattern=all",
      cacheWindowSeconds: 120,
      response: "Source, assembledAt, oldest fetchedAt/expiresAt, per-chart observations, availableCharts, unavailableCharts, sampleSize, samplePlayers, genres, patterns, example games and limitations. A partial result preserves unavailable charts.",
    },
    {
      path: "/api/public/catalog", description: "This endpoint directory, query limits, metric definitions and coverage guidance.",
      parameters: {}, example: "/api/public/catalog",
    },
    {
      path: "/api/games/search", description: "Existing public search by game name, Roblox game URL or numeric place ID.",
      parameters: { q: { required: true, encoding: "game name (at most 80 characters), Roblox game URL or numeric place ID" } },
      example: "/api/games/search?q=Brookhaven",
      cacheWindowSeconds: { nameSearch: 60, placeResolution: 3600, statistics: 60 },
      response: "Source and retrieval/cache times with public game matches. Game URLs are parsed and resolved; arbitrary submitted URLs are never fetched.",
    },
    {
      path: "/api/history/games", description: "Existing directory of up to 100 games with recorded public observations, ordered by latest recorded player count.",
      parameters: {}, example: "/api/history/games",
      response: "available and games. This is a collection directory, not every Roblox game or a live ranking.",
    },
    {
      path: "/api/history", description: "Existing recorded public history for a single game.",
      parameters: {
        universeId: { required: true, encoding: "positive safe-integer universe ID" },
        days: { required: false, type: "integer", minimum: 1, maximum: 30, default: 1 },
      },
      example: "/api/history?universeId=994732206&days=7",
      response: "available, source, from/to, intervalSeconds, sampleCount, gaps and points with actual observation times, statuses and nullable metrics. Unavailable history does not establish zero activity.",
    },
    {
      path: "/api/history/compare", description: "Compare two to five games on matching recorded public collection slots with one fixed cutoff.",
      parameters: {
        universeIds: { required: true, encoding: "comma-separated distinct positive safe-integer universe IDs, without whitespace", minItems: 2, maxItems: 5 },
        days: { required: false, type: "integer", minimum: 1, maximum: 30, default: 1 },
      },
      example: "/api/history/compare?universeIds=994732206,4924922222&days=7",
      comparisonPolicy: {
        ...HISTORY_COMPARISON_POLICY, engineeringHeuristic: true,
        overlapDenominator: "union of the two games' valid recorded slots",
      },
      response: "Status, source, cutoff/from/to, per-game spans and gaps, requested-period coverage, paired/union overlap, paired/requested coverage and matching-slot player-count summaries. Insufficient comparisons retain coverage and withhold statistics. Thresholds are an engineering evidence floor, not significance or a universal guarantee; qualifying short spans must retain requested-period coverage.",
    },
  ],
  queryRules: "For /api/public/*, unknown or repeated parameters, empty supplied values and URLs longer than 2048 characters return 400. Query integers use decimal digits; comma-separated ID whitespace is accepted. Existing search/history routes retain their own validation.",
  httpCaching: "Responses use Cache-Control: no-store. The shared service still reuses bounded process-local observations; cache hits retain fetchedAt and expiresAt rather than presenting old data as newly retrieved.",
  errors: { invalidQuery: 400, upstreamUnavailable: 503, partialCoverage: "Successful responses identify missing games or charts; read their coverage fields." },
  metricDefinitions: METRIC_DEFINITIONS,
  guides: { publicData: "/analytics/data", earningsMethod: "/analytics/earnings-method", mcp: "/connect/guide" },
  mcp: { path: "/mcp", transport: "Streamable HTTP", description: "Optional free read-only tools over these same public services, including definitions and development guides. Connect with an MCP client; it is not a GET JSON endpoint." },
  citation: "Cite the source, universe/chart ID, metric unit and full UTC retrieval timestamp. Keep per-chart times when combining samples. assembledAt is a summary time, not a replacement for fetchedAt.",
  coverage: "Public observations only. Missing metrics are unknown, not zero. History contains only collected observations; reading these endpoints does not enroll a game or backfill data. Current chart samples do not establish market-wide demand, historical growth, gameplay mechanics, actual revenue, retention or demographics. Private connected-game data is excluded.",
} as const;
