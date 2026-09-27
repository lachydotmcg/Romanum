// Public Roblox web APIs. No authentication: these return what anyone can see on roblox.com.

import { getGameIcons } from "./roblox-icons.ts";

const TIMEOUT_MS = 8000;

/** `revalidate` (seconds) lets Next.js reuse the response; without it every call hits Roblox. */
async function getJson<T>(url: string, revalidate?: number): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(revalidate ? { next: { revalidate } } : { cache: "no-store" as const }),
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
  genre?: string | null;
  likes: number;
  dislikes: number;
  /** Paid placement in Roblox search, not a relevance signal. */
  sponsored: boolean;
  /** 150x150 game icon, or null when Roblox has none available. */
  iconUrl?: string | null;
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

  const results = games.slice(0, limit).map((game) => ({
    universeId: game.universeId,
    rootPlaceId: game.rootPlaceId,
    name: game.name,
    playing: game.playerCount,
    likes: game.totalUpVotes,
    dislikes: game.totalDownVotes,
    sponsored: game.isSponsored,
  }));

  if (!results.length) return [];
  // Batch enrichment; a metadata outage must not hide working search results.
  const ids = results.map((game) => game.universeId);
  const [icons, metadata] = await Promise.all([
    getGameIcons(ids),
    getJson<{ data: RobloxGame[] }>(`https://games.roblox.com/v1/games?universeIds=${ids.join(",")}`).catch(() => ({ data: [] })),
  ]);
  const genres = new Map((metadata.data ?? []).map((game) => [game.id, game.genre_l1 || null]));
  return results.map((game) => ({ ...game, genre: genres.get(game.universeId) ?? null, iconUrl: icons.get(game.universeId) ?? null }));
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
  /** 150x150 game icon, or null when Roblox has none available. */
  iconUrl?: string | null;
};

export async function getGameStats(universeIds: number[]): Promise<GameStats[]> {
  const ids = universeIds.join(",");
  const [games, votes, icons] = await Promise.all([
    getJson<{ data: RobloxGame[] }>(`https://games.roblox.com/v1/games?universeIds=${ids}`),
    getJson<{ data: RobloxVotes[] }>(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`),
    getGameIcons(universeIds),
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
      iconUrl: icons.get(game.id) ?? null,
    };
  });
}

/** Roblox's own charts, as shown on roblox.com/charts. */
export const ROBLOX_CHARTS = {
  "top-playing-now": "Top Playing Now",
  "top-trending": "Top Trending",
  "up-and-coming": "Up-and-Coming",
  "top-earning": "Top Earning",
  "top-rated": "Top Rated",
  "top-revisited": "Top Revisited",
  "most-popular": "Most Popular",
  "fun-with-friends": "Fun with Friends",
  "top-paid-access": "Top Paid Access",
} as const;

export type RobloxChartId = keyof typeof ROBLOX_CHARTS;
export const ROBLOX_CHART_IDS = Object.keys(ROBLOX_CHARTS) as RobloxChartId[];

type ExploreGame = {
  universeId: number;
  rootPlaceId: number;
  name: string;
  playerCount: number;
  totalUpVotes: number;
  totalDownVotes: number;
  isSponsored: boolean;
  genreL1?: string;
};

export type ChartGame = {
  rank: number;
  universeId: number;
  rootPlaceId: number;
  name: string;
  playing: number;
  likes: number;
  dislikes: number;
  genre: string | null;
  sponsored: boolean;
  /** 150x150 game icon, or null when Roblox has none available. */
  iconUrl?: string | null;
};

// Any stable ID works; keeping it fixed keeps the URL stable so cached responses can be reused.
const EXPLORE_SESSION = "7f3c2a9e-2b1d-4c6e-9a8f-5d4e3c2b1a09";

/** Games in one of Roblox's charts, in chart order. Uses the endpoint behind roblox.com/charts (undocumented). */
export async function getRobloxChart(chart: RobloxChartId, revalidate?: number): Promise<ChartGame[]> {
  const url = new URL("https://apis.roblox.com/explore-api/v1/get-sort-content");
  url.searchParams.set("sessionId", revalidate ? EXPLORE_SESSION : crypto.randomUUID());
  url.searchParams.set("sortId", chart);
  url.searchParams.set("device", "computer");
  url.searchParams.set("country", "all");

  const data = await getJson<{ games?: ExploreGame[] }>(url.toString(), revalidate);
  if (!Array.isArray(data.games)) throw new Error("Roblox chart response is missing games.");
  const chartGames = (data.games ?? []).map((game, index) => ({
    rank: index + 1,
    universeId: game.universeId,
    rootPlaceId: game.rootPlaceId,
    name: game.name,
    playing: game.playerCount,
    likes: game.totalUpVotes,
    dislikes: game.totalDownVotes,
    genre: game.genreL1 || null,
    sponsored: game.isSponsored,
  }));

  // One request for the whole chart, never one per row.
  const icons = await getGameIcons(chartGames.map((game) => game.universeId));
  return chartGames.map((game) => ({ ...game, iconUrl: icons.get(game.universeId) ?? null }));
}

export async function universeIdForPlace(placeId: number): Promise<number> {
  const data = await getJson<{ universeId: number | null }>(
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
  );
  if (!data.universeId) throw new Error(`No game found for place ${placeId}.`);
  return data.universeId;
}
