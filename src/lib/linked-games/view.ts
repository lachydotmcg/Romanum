import type { Database } from "@/lib/history/database";
import { publicData } from "@/lib/public-data";
import { listLinkedGames, readGameMetrics, type LinkedGame, type MetricPoint } from "./store";
import { SYNCED_METRICS, type MetricUnit } from "./metrics";

// What the profile shows for each linked game: its public name and icon beside its private status and latest metrics.

export type MetricSummary = { metric: string; label: string; unit: MetricUnit; latest: MetricPoint | null };
export type LinkedGameView = LinkedGame & { name: string | null; iconUrl: string | null; metrics: MetricSummary[] };

/** Public names and icons for linked games. Private data never goes into this public request, only universe IDs. */
async function publicNames(universeIds: number[]): Promise<Map<number, { name: string; iconUrl: string | null }>> {
  if (!universeIds.length) return new Map();
  try {
    const { games } = await publicData.stats(universeIds);
    return new Map(games.map((game) => [game.universeId, { name: game.name, iconUrl: game.iconUrl ?? null }]));
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
        metrics: SYNCED_METRICS.map(({ metric, label, unit }) => ({ metric, label, unit, latest: metrics[metric]?.at(-1) ?? null })),
      };
    }),
  );
}
