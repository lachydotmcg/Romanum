import { DataCache } from "./data-cache.ts";
import { historyService } from "./history/service.ts";
import { analyzeMarket, type ChartSample } from "./market-analysis.ts";
import { getGameStats, getRobloxChart, searchGames, universeIdForPlace, type RobloxChartId } from "./roblox.ts";

export const MARKET_CHARTS = ["top-playing-now", "top-trending", "up-and-coming", "top-earning"] as const;
const upstream = { getGameStats, getRobloxChart, searchGames, universeIdForPlace };

/** Shared by the website, integrated assistant and MCP; no model provider dependency. */
export function createPublicDataService(loaders = upstream, cache = new DataCache()) {
  const chart = async (chartId: RobloxChartId) => {
    // Cache the complete observation here so its timestamp ages with its data.
    const { value: games, ...freshness } = await cache.get(`chart:${chartId}`, 120, () => loaders.getRobloxChart(chartId));
    return { ...freshness, cacheWindowSeconds: 120, source: "https://www.roblox.com/charts", chartId, games };
  };
  return {
    history: historyService.history,
    async search(query: string) {
      const { value: games, ...freshness } = await cache.get(`search:${query}`, 60, () => loaders.searchGames(query));
      return { ...freshness, cacheWindowSeconds: 60, source: "https://apis.roblox.com/search-api/omni-search", games };
    },
    async stats(universeIds: number[]) {
      const ids = [...new Set(universeIds)].sort((a, b) => a - b);
      const { value: games, ...freshness } = await cache.get(`stats:${ids.join(",")}`, 60, () => loaders.getGameStats(ids));
      return {
        ...freshness, cacheWindowSeconds: 60,
        source: "https://games.roblox.com/v1/games", requestedUniverseIds: ids,
        missingUniverseIds: ids.filter((id) => !games.some((game) => game.universeId === id)), games,
      };
    },
    async resolve(placeId: number) {
      const { value: universeId, ...freshness } = await cache.get(`place:${placeId}`, 3600, () => loaders.universeIdForPlace(placeId));
      return { ...freshness, cacheWindowSeconds: 3600, source: `https://apis.roblox.com/universes/v1/places/${placeId}/universe`, placeId, universeId };
    },
    chart,
    async market() {
      const observations = await Promise.all(MARKET_CHARTS.map(async (id) => {
        try { return await chart(id); } catch { return null; }
      }));
      const samples: ChartSample[] = MARKET_CHARTS.map((id, i) => ({ chart: id, games: observations[i]?.games ?? null }));
      return {
        samples, analysis: analyzeMarket(samples),
        observations: observations.flatMap((observation) => observation ? [{ chart: observation.chartId, fetchedAt: observation.fetchedAt, expiresAt: observation.expiresAt }] : []),
      };
    },
  };
}

export type PublicDataService = ReturnType<typeof createPublicDataService>;
export const publicData = createPublicDataService();
