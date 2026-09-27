import { timingSafeEqual } from "node:crypto";

type Environment = Record<string, string | undefined>;

/** Separate from the credential encryption key; only the timer and worker use it. */
export function collectorAuthorized(request: Request, env: Environment = process.env): boolean {
  const secret = env.HISTORY_COLLECTOR_TOKEN;
  if (!secret || secret.length < 32 || request.method !== "POST") return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function dispatchCollection(env: Environment = process.env, send: typeof fetch = fetch): Promise<void> {
  if (!env.HISTORY_COLLECTOR_TOKEN || env.HISTORY_COLLECTOR_TOKEN.length < 32) throw new Error("Collector token is not configured.");
  const origin = new URL(env.HISTORY_COLLECTOR_ORIGIN ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Collector origin must be an HTTPS origin.");
  }
  const response = await send(new URL("/.netlify/functions/history-collect-background", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${env.HISTORY_COLLECTOR_TOKEN}` },
    // Never forward the worker credential to redirects, including a custom-domain redirect.
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 202) throw new Error("Collector dispatch was not accepted.");
}

/** One retry for transient upstream failures, always fetching a new observation. */
export async function retryCollectionRead<T>(read: () => Promise<T>, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<T> {
  try { return await read(); }
  catch { await sleep(1000); return read(); }
}
