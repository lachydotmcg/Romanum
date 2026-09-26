/** Per-process backstop. Shared edge limits are still needed across multiple replicas. */
export class RequestLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  private limit: number;
  private now: () => number;
  constructor(limit = 300, now = Date.now) {
    this.limit = limit;
    this.now = now;
  }
  take(key: string): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      if (this.buckets.size >= 10_000) {
        for (const [id, item] of this.buckets) if (item.reset <= now) this.buckets.delete(id);
        // Never evict an active bucket and reset its quota under an attacker-chosen key.
        if (this.buckets.size >= 10_000 && !this.buckets.has(key)) return 60;
      }
      bucket = { count: 0, reset: now + 60_000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) return Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    bucket.count++;
    return 0;
  }
}

export function createToolGate(limit = 8) {
  let active = 0;
  return async function withSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limit) throw new BusyError("Server busy. Try again shortly.");
    active++;
    try { return await operation(); } finally { active--; }
  };
}

export class BusyError extends Error {}
