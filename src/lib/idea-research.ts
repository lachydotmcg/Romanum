import { z } from "zod";
import { publicData, type PublicDataService } from "./public-data.ts";

export const IDEA_RESEARCH_INPUT = z.object({
  title: z.string().trim().min(1).max(80),
  terms: z.array(z.string().trim().min(1).max(80)).min(1).max(2).describe("One or two core mechanic/fantasy searches, not just the proposed title."),
}).strict();

/** Search coverage is evidence of possible competitors, never a novelty or quality verdict. */
export async function researchGameIdea(input: unknown, service: PublicDataService = publicData) {
  const { title, terms } = IDEA_RESEARCH_INPUT.parse(input);
  const queries = [...new Map([title, ...terms].map((query) => [query.toLocaleLowerCase("en-US"), query])).values()];
  const searches = await Promise.all(queries.map(async (query) => {
    try {
      const observation = await service.search(query);
      return { query, status: "complete" as const, observation };
    } catch {
      return { query, status: "unavailable" as const, observation: null };
    }
  }));
  const games = new Map<number, { universeId: number; rootPlaceId: number; name: string; playing: number; likes: number; dislikes: number; iconUrl: string | null; sponsored: boolean; matchedQueries: string[]; fetchedAt: string }>();
  for (const search of searches) {
    if (!search.observation) continue;
    for (const game of search.observation.games.slice(0, 10)) {
      if (!Number.isSafeInteger(game.universeId) || game.universeId <= 0) continue;
      const previous = games.get(game.universeId);
      const matchedQueries = [...new Set([...(previous?.matchedQueries ?? []), search.query])];
      if (previous && previous.fetchedAt > search.observation.fetchedAt) {
        previous.matchedQueries = matchedQueries;
      } else {
        games.set(game.universeId, { ...game, iconUrl: game.iconUrl ?? null, matchedQueries, fetchedAt: search.observation.fetchedAt });
      }
    }
  }
  return {
    title,
    status: searches.every((search) => search.status === "complete") ? "complete" : searches.some((search) => search.status === "complete") ? "partial" : "unavailable",
    searches: searches.map(({ query, status, observation }) => ({ query, status, fetchedAt: observation?.fetchedAt ?? null, resultCount: observation?.games.length ?? null })),
    games: [...games.values()],
    source: "https://apis.roblox.com/search-api/omni-search",
    interpretation: "Search matches are candidate competitors. An empty result does not prove the idea is new. Names, icons and popularity do not establish gameplay quality, audience age or whether a proposed improvement is absent. Inspect gameplay or obtain specific developer evidence before comparing execution.",
  };
}
