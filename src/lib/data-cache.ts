export type CachedObservation<T> = { value: T; fetchedAt: string; expiresAt: string };

/** Conservative per-process limit for active public-data loaders; excess keys are never queued. */
export const DATA_CACHE_MAX_IN_FLIGHT = 32;

export class DataCacheOverloadError extends Error {
  constructor() {
    super("Public data lookups are busy. Try again.");
    this.name = "DataCacheOverloadError";
  }
}

/** Completed observations are bounded separately from active, deduplicated lookups.
 * New keys reject at 32 active loaders; cached hits and existing waiters still work.
 * There is no internal queue. Public handlers already sanitize rejected lookups to 503.
 * Fetchers retain ownership of their timeout/cancellation; failures free their slot.
 */
export class DataCache {
  private entries = new Map<string, { expires: number; observation: CachedObservation<unknown> }>();
  private inFlight = new Map<string, Promise<CachedObservation<unknown>>>();
  private maxEntries: number;
  private now: () => number;

  constructor(maxEntries = 200, now = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async get<T>(key: string, seconds: number, fetcher: () => Promise<T>): Promise<CachedObservation<T>> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.observation as CachedObservation<T>;
    this.entries.delete(key);

    const active = this.inFlight.get(key);
    if (active) return active as Promise<CachedObservation<T>>;
    if (this.inFlight.size >= DATA_CACHE_MAX_IN_FLIGHT) throw new DataCacheOverloadError();

    // Defer invocation so even synchronous throws clean up an already registered entry.
    const pending = Promise.resolve().then(fetcher).then((value) => {
      const fetched = this.now();
      const expires = fetched + seconds * 1000;
      const observation = { value, fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(expires).toISOString() };
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { expires, observation });
      return observation;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }
}
