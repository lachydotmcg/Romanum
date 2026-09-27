import { z } from "zod";

// Roblox Open Cloud calls made with a person's own API key: key introspection, and the Analytics Query API
// (create.roblox.com/docs/cloud/guides/analytics), which is in beta. The key needs the universe.analytics:read
// operation for the experience, and the API allows 30 queries a minute per key owner.

export const OPEN_CLOUD = {
  analytics: "https://apis.roblox.com/analytics-query-api/",
  introspect: "https://apis.roblox.com/api-keys/v1/introspect",
} as const;

const TIMEOUT_MS = 15_000;
/** Polls of a long-running query before giving up; with the backoff below, about a minute. */
const POLL_LIMIT = 10;

export type OpenCloudFailure = "key_rejected" | "rate_limited" | "bad_request" | "unavailable";

export class OpenCloudError extends Error {
  kind: OpenCloudFailure;
  constructor(kind: OpenCloudFailure, message: string) {
    super(message);
    this.name = "OpenCloudError";
    this.kind = kind;
  }
}

export type OpenCloudOptions = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function call(request: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new OpenCloudError("unavailable", "Couldn't reach Roblox.");
  }
  if (response.status === 401 || response.status === 403) throw new OpenCloudError("key_rejected", "Roblox rejected the API key for this game.");
  if (response.status === 429) throw new OpenCloudError("rate_limited", "Roblox is rate limiting this key. Try again in a minute.");
  if (response.status === 404) throw new OpenCloudError("bad_request", "Roblox couldn't find that game.");
  const body = await response.json().catch(() => null);
  if (response.status === 400) throw new OpenCloudError("bad_request", "Roblox refused the query.");
  if (!response.ok) throw new OpenCloudError("unavailable", `Roblox returned ${response.status}.`);
  return body;
}

const operation = z.object({
  path: z.string().optional(),
  done: z.boolean(),
  response: z
    .object({
      values: z.array(
        z.object({
          dataPoints: z.array(z.object({ time: z.string(), value: z.number().nullish(), status: z.string().nullish() })),
        }),
      ),
    })
    .optional(),
  error: z.object({ code: z.number().optional() }).optional(),
});

/** A pending query's operation, to poll. Checked, since the URL is built from what Roblox sent. */
const OPERATION_PATH = /^v1\/universes\/\d+\/operations\/metrics\/[\w.~-]{1,200}$/;

export type DailyValue = { day: string; value: number; status: string | null };

/**
 * One metric's daily values for a game, from `start` (inclusive) to `end` (exclusive), both UTC midnights. Polls
 * the query while Roblox runs it as a long-running operation.
 */
export async function queryDailyMetric(
  apiKey: string,
  universeId: number,
  metric: string,
  range: { start: Date; end: Date },
  options: OpenCloudOptions = {},
): Promise<DailyValue[]> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? wait;
  const body = JSON.stringify({ metric, granularity: "OneDay", startTime: range.start.toISOString(), endTime: range.end.toISOString() });
  let result = operation.safeParse(
    await call(request, `${OPEN_CLOUD.analytics}v1/universes/${universeId}/metrics`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body,
    }),
  );
  for (let poll = 0; result.success && !result.data.done; poll++) {
    const path = result.data.path?.replace(/^\//, "");
    if (poll >= POLL_LIMIT || !path || !OPERATION_PATH.test(path)) throw new OpenCloudError("unavailable", "Roblox took too long to answer.");
    await sleep(Math.min(1000 * 2 ** poll, 8000));
    result = operation.safeParse(await call(request, `${OPEN_CLOUD.analytics}${path}`, { headers: { "x-api-key": apiKey, accept: "application/json" } }));
  }
  if (!result.success) throw new OpenCloudError("unavailable", "Roblox sent an unexpected answer.");
  if (result.data.error) {
    const code = result.data.error.code;
    throw code === 3000
      ? new OpenCloudError("rate_limited", "The query asked for too much data.")
      : new OpenCloudError(code === 2001 ? "bad_request" : "unavailable", "Roblox couldn't answer the query.");
  }
  // Without a breakdown, the answer is a single series.
  return (result.data.response?.values[0]?.dataPoints ?? []).flatMap((point) => {
    const day = point.time.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && typeof point.value === "number" && Number.isFinite(point.value)
      ? [{ day, value: point.value, status: point.status ?? null }]
      : [];
  });
}

const introspection = z.object({
  enabled: z.boolean().nullish(),
  expired: z.boolean().nullish(),
  expirationTimeUtc: z.string().nullish(),
  scopes: z
    .array(z.object({ name: z.string(), operations: z.array(z.string()).nullish(), universeIds: z.array(z.string()).nullish() }))
    .nullish(),
});

export type KeyInfo = {
  enabled: boolean | null;
  expired: boolean | null;
  expiresAt: string | null;
  /** The experiences the key can read analytics for ("*" for all), or null when Roblox doesn't say. */
  analyticsUniverseIds: string[] | null;
};

/**
 * What Roblox reports about an API key. Null when introspection fails or answers in an unfamiliar shape: linking then
 * relies on a test query instead.
 */
export async function introspectKey(apiKey: string, options: OpenCloudOptions = {}): Promise<KeyInfo | null> {
  try {
    const parsed = introspection.safeParse(
      await call(options.fetch ?? fetch, OPEN_CLOUD.introspect, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );
    if (!parsed.success) return null;
    const scope = parsed.data.scopes?.find((item) => /analytics/i.test(item.name) && (item.operations ?? []).includes("read"));
    const expiry = parsed.data.expirationTimeUtc ? new Date(parsed.data.expirationTimeUtc) : null;
    return {
      enabled: parsed.data.enabled ?? null,
      expired: parsed.data.expired ?? null,
      expiresAt: expiry && !Number.isNaN(expiry.valueOf()) ? expiry.toISOString() : null,
      analyticsUniverseIds: scope?.universeIds ?? null,
    };
  } catch {
    return null;
  }
}
