import type { Database } from "@/lib/history/database";
import { getGameIcons } from "@/lib/roblox-icons";
import { publicData } from "@/lib/public-data";
import { listLinkedGames, readGameMetrics, type LinkedGame, type MetricPoint } from "./store";
import { dailyMetricChange, type DailyMetricChange } from "./changes";
import { SYNCED_METRICS, type MetricUnit } from "./metrics";

// What the profile shows for each linked game: its public name and icon beside its private status and latest metrics.

export type MetricSummary = { metric: string; label: string; unit: MetricUnit; latest: MetricPoint | null; change: DailyMetricChange | null };
export type LinkedGameView = LinkedGame & { name: string | null; iconUrl: string | null; creatorName: string | null; playing: number | null; likeRatio: number | null; publicFetchedAt: string | null; metrics: MetricSummary[] };

/** Public names and icons for linked games. Private data never goes into this public request, only universe IDs. */
async function publicNames(universeIds: number[]): Promise<Map<number, { name: string; iconUrl: string | null; creatorName: string; playing: number | null; likeRatio: number | null; fetchedAt: string }>> {
  if (!universeIds.length) return new Map();
  try {
    const [{ games, fetchedAt }, artwork] = await Promise.all([publicData.stats(universeIds), getGameIcons(universeIds, "512x512")]);
    return new Map(games.map((game) => [game.universeId, { name: game.name, iconUrl: artwork.get(game.universeId) ?? game.iconUrl ?? null, creatorName: game.creator.name, playing: game.playing, likeRatio: game.likeRatio, fetchedAt }]));
  } catch {
    return new Map();
  }
}

export async function linkedGameViews(database: Database, accountId: string, games?: LinkedGame[]): Promise<LinkedGameView[]> {
  const list = games ?? (await listLinkedGames(database, accountId));
  const names = await publicNames(list.map((game) => game.universeId));
  return Promise.all(
    list.map(async (game) => {
      const metrics = await readGameMetrics(database, accountId, game.id);
      return {
        ...game,
        name: names.get(game.universeId)?.name ?? null,
        iconUrl: names.get(game.universeId)?.iconUrl ?? null,
        creatorName: names.get(game.universeId)?.creatorName ?? null,
        playing: names.get(game.universeId)?.playing ?? null,
        likeRatio: names.get(game.universeId)?.likeRatio ?? null,
        publicFetchedAt: names.get(game.universeId)?.fetchedAt ?? null,
        metrics: SYNCED_METRICS.map(({ metric, label, unit }) => ({ metric, label, unit, latest: metrics[metric]?.at(-1) ?? null, change: dailyMetricChange(metrics[metric] ?? [], unit) })),
      };
    }),
  );
}
