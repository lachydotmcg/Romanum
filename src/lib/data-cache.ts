export type CachedObservation<T> = { value: T; fetchedAt: string; expiresAt: string };

/** Bounded, process-local cache. Concurrent identical lookups share one upstream request. */
export class DataCache {
  private entries = new Map<string, { expires: number; pending: Promise<CachedObservation<unknown>> }>();
  private maxEntries: number;
  private now: () => number;

  constructor(maxEntries = 200, now = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async get<T>(key: string, seconds: number, fetcher: () => Promise<T>): Promise<CachedObservation<T>> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.pending as Promise<CachedObservation<T>>;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);

    // Defer invocation so even synchronous throws clean up an already registered entry.
    const entry: { expires: number; pending: Promise<CachedObservation<T>> } = {
      expires: Infinity,
      pending: Promise.resolve().then(fetcher).then((value) => {
        const fetched = this.now();
        entry.expires = fetched + seconds * 1000;
        return { value, fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(entry.expires).toISOString() };
      }).catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }),
    };
    this.entries.set(key, entry);
    return entry.pending;
  }
}
