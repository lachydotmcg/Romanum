import { introspectKey, OpenCloudError, queryDailyMetric, type OpenCloudOptions } from "./open-cloud.ts";

// Checks an API key with Roblox before it's stored: introspection when Roblox answers it, then a small test query,
// which proves the key can read this game's analytics. A key that works is also proof of authority over the game.

/** A first check before anything goes to Roblox: API keys are long printable strings without spaces. */
export function plausibleApiKey(value: string): boolean {
  return value.length >= 20 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

export type KeyCheck = { ok: true; expiresAt: string | null } | { ok: false; message: string };

const MESSAGES = {
  key_rejected: "Roblox rejected this key for this game. It needs universe.analytics:read for the game.",
  rate_limited: "Roblox is rate limiting this key. Try again in a minute.",
  bad_request: "Roblox has no analytics for that universe ID.",
  unavailable: "Couldn't reach Roblox. Try again.",
} as const;

export async function checkGameKey(apiKey: string, universeId: number, options: OpenCloudOptions & { now?: Date } = {}): Promise<KeyCheck> {
  const info = await introspectKey(apiKey, options);
  if (info?.enabled === false) return { ok: false, message: "This key is disabled. Turn it on in Creator Dashboard." };
  if (info?.expired === true) return { ok: false, message: "This key has expired." };
  const universes = info?.analyticsUniverseIds;
  if (universes && !universes.includes("*") && !universes.includes(String(universeId))) {
    return { ok: false, message: "This key can't read this game's analytics." };
  }
  const now = options.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    await queryDailyMetric(apiKey, universeId, "DailyActiveUsers", { start: new Date(end.getTime() - 3 * 86_400_000), end }, options);
  } catch (error) {
    return { ok: false, message: MESSAGES[error instanceof OpenCloudError ? error.kind : "unavailable"] };
  }
  return { ok: true, expiresAt: info?.expiresAt ?? null };
}
