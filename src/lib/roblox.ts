// Public Roblox web APIs. No authentication: these return what anyone can see on roblox.com.

const TIMEOUT_MS = 8000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Roblox returned ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

type OmniSearchResponse = {
  searchResults?: {
    contentGroupType: string;
    contents?: {
      universeId: number;
      rootPlaceId: number;
      name: string;
      playerCount: number;
      totalUpVotes: number;
      totalDownVotes: number;
      isSponsored: boolean;
    }[];
  }[];
};

export type GameSearchResult = {
  universeId: number;
  rootPlaceId: number;
  name: string;
  playing: number;
  likes: number;
  dislikes: number;
  /** Paid placement in Roblox search, not a relevance signal. */
  sponsored: boolean;
};

/** Search games by name. Uses the endpoint behind roblox.com's own search box (undocumented). */
export async function searchGames(query: string, limit = 10): Promise<GameSearchResult[]> {
  const url = new URL("https://apis.roblox.com/search-api/omni-search");
  url.searchParams.set("searchQuery", query);
  url.searchParams.set("sessionId", crypto.randomUUID());
  url.searchParams.set("pageType", "all");

  const data = await getJson<OmniSearchResponse>(url.toString());
  const games = (data.searchResults ?? [])
    .filter((group) => group.contentGroupType === "Game")
    .flatMap((group) => group.contents ?? []);

  return games.slice(0, limit).map((game) => ({
    universeId: game.universeId,
    rootPlaceId: game.rootPlaceId,
    name: game.name,
    playing: game.playerCount,
    likes: game.totalUpVotes,
    dislikes: game.totalDownVotes,
    sponsored: game.isSponsored,
  }));
}

type RobloxGame = {
  id: number;
  rootPlaceId: number;
  name: string;
  creator: { name: string; type: string; hasVerifiedBadge?: boolean };
  playing: number;
  visits: number;
  maxPlayers: number;
  created: string;
  updated: string;
  favoritedCount: number;
  genre_l1?: string;
  genre_l2?: string;
};

type RobloxVotes = { id: number; upVotes: number; downVotes: number };

export type GameStats = {
  universeId: number;
  rootPlaceId: number;
  name: string;
  creator: { name: string; type: string };
  playing: number;
  visits: number;
  favorites: number;
  likes: number | null;
  dislikes: number | null;
  /** Share of votes that are likes, 0 to 1. Null when there are no votes. */
  likeRatio: number | null;
  maxPlayersPerServer: number;
  genre: string | null;
  created: string;
  updated: string;
};

export async function getGameStats(universeIds: number[]): Promise<GameStats[]> {
  const ids = universeIds.join(",");
  const [games, votes] = await Promise.all([
    getJson<{ data: RobloxGame[] }>(`https://games.roblox.com/v1/games?universeIds=${ids}`),
    getJson<{ data: RobloxVotes[] }>(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`),
  ]);
  const votesById = new Map(votes.data.map((v) => [v.id, v]));

  return games.data.map((game) => {
    const vote = votesById.get(game.id);
    const total = vote ? vote.upVotes + vote.downVotes : 0;
    return {
      universeId: game.id,
      rootPlaceId: game.rootPlaceId,
      name: game.name,
      creator: { name: game.creator.name, type: game.creator.type },
      playing: game.playing,
      visits: game.visits,
      favorites: game.favoritedCount,
      likes: vote?.upVotes ?? null,
      dislikes: vote?.downVotes ?? null,
      likeRatio: vote && total > 0 ? vote.upVotes / total : null,
      maxPlayersPerServer: game.maxPlayers,
      genre: [game.genre_l1, game.genre_l2].filter(Boolean).join(" / ") || null,
      created: game.created,
      updated: game.updated,
    };
  });
}

export async function universeIdForPlace(placeId: number): Promise<number> {
  const data = await getJson<{ universeId: number | null }>(
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
  );
  if (!data.universeId) throw new Error(`No game found for place ${placeId}.`);
  return data.universeId;
}
