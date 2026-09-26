import { z } from "zod";
import { publicData, type PublicDataService } from "./public-data.ts";
import { parsePlaceId, PUBLIC_TOOLS } from "./public-tools.ts";

const searchInput = z.string().trim().min(1).max(300);
const universeInput = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export function parseUniverseId(value: string): number {
  return universeInput.parse(value);
}

/** UI composition of the same search, resolve and stats operations exposed through MCP.
 * Numeric input means place ID, matching Roblox links. Detail routes use universe IDs.
 * Never fetch a user-supplied URL: parse it, then call the fixed Roblox resolver.
 */
export async function searchPublicGames(input: unknown, service: PublicDataService = publicData) {
  const query = searchInput.parse(input);
  if (/^\d+$/.test(query) || /(?:^[a-z][a-z\d+.-]*:\/\/|^https?:|^roblox\.com|^www\.|\/games\/)/i.test(query)) {
    const placeId = parsePlaceId(query);
    const { universeId } = await service.resolve(placeId);
    const ids = PUBLIC_TOOLS.get_game_stats.schema.parse({ universeIds: [universeId] });
    const result = await service.stats(ids.universeIds);
    return { ...result, games: result.games.map((game) => ({ ...game, sponsored: false })) };
  }
  const { query: name } = PUBLIC_TOOLS.search_games.schema.parse({ query });
  return service.search(name);
}

export async function loadPublicGame(rawId: string, service: PublicDataService = publicData) {
  const universeId = parseUniverseId(rawId);
  const observation = await service.stats([universeId]);
  return { ...observation, game: observation.games.find((game) => game.universeId === universeId) ?? null };
}
