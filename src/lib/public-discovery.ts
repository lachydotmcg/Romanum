export const PUBLIC_ORIGIN = "https://romanum.dev";
export const MAX_SITEMAP_GAMES = 100;

const ANALYTICS_PAGES = {
  overview: { title: "Public Roblox analytics", description: "Explore public Roblox game statistics, chart samples and game design hypotheses. Free to browse, without signing in or installing MCP." },
  games: { title: "Roblox game statistics", description: "Browse Roblox games with public concurrent players, cumulative visits, favourites and vote ratios. Open a game for its source and retrieval time." },
  trends: { title: "Roblox charts and title patterns", description: "Explore Roblox Trending, Up-and-Coming and Top Earning rankings, plus title patterns in the loaded chart sample. Patterns are not measured growth or proof of demand." },
  genres: { title: "Roblox genre chart samples", description: "Compare concurrent players and genre shares across the loaded, non-sponsored Roblox chart sample. These shares do not represent all of Roblox." },
  charts: { title: "Compare Roblox game charts", description: "Compare real public Roblox game statistics in charts and tables. Earnings estimates are modelled separately from observed counts." },
  earnings: { title: "Roblox earnings estimate calculator", description: "Explore heuristic Roblox earnings estimates from concurrent players, period and genre assumptions. Estimates are not actual revenue or historical earnings." },
} as const;

export function analyticsPageMetadata(requestedView?: unknown) {
  const view = typeof requestedView === "string" && Object.hasOwn(ANALYTICS_PAGES, requestedView) ? requestedView as keyof typeof ANALYTICS_PAGES : "overview";
  return { ...ANALYTICS_PAGES[view], alternates: { canonical: `${PUBLIC_ORIGIN}/analytics${view === "overview" ? "" : `?view=${view}`}` } };
}

/** Only public identity enters metadata, never the account's connected analytics. */
export function publicGameMetadata(game: { universeId: number; name: string }) {
  return {
    title: `${game.name} Roblox analytics`,
    description: `Public Roblox statistics for ${game.name}: concurrent players, cumulative visits, favourites and vote ratio, with source and retrieval time. Recorded history is available only where collected.`,
    alternates: { canonical: `${PUBLIC_ORIGIN}/analytics/games/${game.universeId}` },
  };
}

export function utcObservationTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export const PUBLIC_GUIDE_LINKS = [
  { href: "/analytics?view=games", label: "Game statistics" },
  { href: "/analytics?view=trends", label: "Charts and title patterns" },
  { href: "/analytics?view=genres", label: "Genre samples" },
  { href: "/analytics/earnings-method", label: "Earnings estimate method" },
  { href: "/connect", label: "Optional free MCP connection" },
  { href: "/connect/guide", label: "MCP tool and coverage guide" },
] as const;

const FIXED_PUBLIC_PATHS = [
  "/analytics", "/analytics?view=games", "/analytics?view=trends", "/analytics?view=genres",
  "/analytics?view=charts", "/analytics?view=earnings", "/analytics/data",
  "/analytics/earnings-method", "/connect", "/connect/guide", "/privacy",
] as const;

/** Fixed public routes plus a bounded public history directory; no submitted URLs or private fields. */
export function publicSitemapEntries(games: readonly { universeId: unknown }[] = []) {
  const urls = new Set<string>(FIXED_PUBLIC_PATHS.map(path => `${PUBLIC_ORIGIN}${path}`));
  for (const { universeId } of games.slice(0, MAX_SITEMAP_GAMES)) {
    if (typeof universeId === "number" && Number.isSafeInteger(universeId) && universeId > 0) {
      urls.add(`${PUBLIC_ORIGIN}/analytics/games/${universeId}`);
    }
  }
  // No invented lastmod: a request time or Roblox game update is not a page-change timestamp.
  return [...urls].map(url => ({ url }));
}

export async function loadPublicSitemap(readGames: () => Promise<{ games: { universeId: unknown }[] }>) {
  try { return publicSitemapEntries((await readGames()).games); }
  catch { return publicSitemapEntries(); }
}
