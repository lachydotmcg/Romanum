// Public Roblox thumbnail APIs. No authentication: these are the same images roblox.com renders.
//
// One request covers up to 100 universes, so callers enrich a whole table or chart with a single
// round trip instead of one request per rendered row.

const ICONS_ENDPOINT = "https://thumbnails.roblox.com/v1/games/icons";
/** Roblox rejects requests above 100 ids. */
const MAX_IDS_PER_REQUEST = 100;
const TIMEOUT_MS = 4500;
/** Seconds; lets Next.js reuse a chart's icons between renders instead of refetching them. */
const REVALIDATE_SECONDS = 3600;

type ThumbnailResponse = {
  data?: {
    /** Roblox does not guarantee response order, so records must be matched back by targetId. */
    targetId?: unknown;
    state?: unknown;
    imageUrl?: unknown;
  }[];
};

/** Only a plain https rbxcdn.com URL (or subdomain), no credentials, standard port. */
export function isRobloxImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return host === "rbxcdn.com" || host.endsWith(".rbxcdn.com");
}

function validUniverseId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Fetch one batch and keep only completed images whose targetId we actually asked for. */
async function fetchIconBatch(ids: number[], size: "150x150" | "512x512"): Promise<Map<number, string>> {
  const icons = new Map<number, string>();

  const url = new URL(ICONS_ENDPOINT);
  url.searchParams.set("universeIds", ids.join(","));
  url.searchParams.set("size", size);
  url.searchParams.set("format", "Png");
  url.searchParams.set("isCircular", "false");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch {
    // Timeout, DNS failure, offline: icons are decoration, so callers carry on without them.
    return icons;
  }
  if (!res.ok) return icons;

  let payload: ThumbnailResponse;
  try {
    payload = (await res.json()) as ThumbnailResponse;
  } catch {
    return icons;
  }
  if (!Array.isArray(payload?.data)) return icons;

  const wanted = new Set(ids);
  for (const record of payload.data) {
    if (!record || typeof record !== "object") continue;
    const id = validUniverseId(record.targetId);
    // Matching on targetId (not array position) keeps shuffled or partial responses correct.
    if (id === null || !wanted.has(id)) continue;
    // Unavailable/Blocked/Pending/Error entries carry no usable image.
    if (record.state !== "Completed") continue;
    if (!isRobloxImageUrl(record.imageUrl)) continue;
    icons.set(id, record.imageUrl);
  }

  return icons;
}

/**
 * Square icons for the given universes (150x150 by default; 512x512 for artwork), keyed by universeId.
 *
 * Ids are validated, deduped and sorted before batching so the request URLs stay stable (and
 * therefore cacheable) for a given set of games. Failures are swallowed: a broken thumbnail
 * request never breaks the statistics a caller actually asked for.
 */
export async function getGameIcons(universeIds: number[], size: "150x150" | "512x512" = "150x150"): Promise<Map<number, string>> {
  const icons = new Map<number, string>();
  if (!Array.isArray(universeIds)) return icons;

  const ids = [...new Set(universeIds.map(validUniverseId).filter((id): id is number => id !== null))].sort(
    (a, b) => a - b,
  );
  if (ids.length === 0) return icons;

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    batches.push(ids.slice(i, i + MAX_IDS_PER_REQUEST));
  }

  const results = await Promise.all(batches.map((batch) => fetchIconBatch(batch, size)));
  for (const batch of results) {
    for (const [id, imageUrl] of batch) icons.set(id, imageUrl);
  }

  return icons;
}
