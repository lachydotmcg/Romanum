import test from "node:test";
import assert from "node:assert/strict";
import { DataCache, DATA_CACHE_MAX_IN_FLIGHT, DataCacheOverloadError } from "../src/lib/data-cache.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { createPublicHttpHandler } from "../src/lib/public-http.ts";

const deferred = () => Promise.withResolvers();

test("more than 200 distinct pending keys cannot exceed the loader cap or enqueue work", async () => {
  const cache = new DataCache();
  const gates = [];
  let calls = 0;
  const load = () => {
    calls++;
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  };
  const requests = Array.from({ length: 401 }, (_, i) => cache.get(`stats:${i}`, 60, load));
  const settled = Promise.allSettled(requests);
  await Promise.resolve();
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT);
  const overloads = await Promise.allSettled(requests.slice(DATA_CACHE_MAX_IN_FLIGHT));
  assert.ok(overloads.every(result => result.status === "rejected" && result.reason instanceof DataCacheOverloadError));
  const waiter = cache.get("stats:0", 60, () => assert.fail("pending key lost deduplication"));
  gates[0].resolve("first");
  assert.strictEqual(await waiter, await requests[0]);
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT, "rejected work must not start when a slot frees");
  assert.equal((await cache.get("stats:recovered", 60, async () => { calls++; return "retry"; })).value, "retry");
  for (const gate of gates.slice(1)) gate.resolve("fixture");
  const results = await settled;
  assert.equal(results.filter(result => result.status === "fulfilled").length, DATA_CACHE_MAX_IN_FLIGHT);
  assert.equal(results.filter(result => result.status === "rejected").length, 401 - DATA_CACHE_MAX_IN_FLIGHT);
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT + 1);
});

test("completed-cache eviction cannot evict a pending key or start a duplicate loader", async () => {
  const cache = new DataCache(2);
  const gate = deferred();
  const first = cache.get("slow", 60, () => gate.promise);
  for (const key of ["a", "b", "c"]) await cache.get(key, 60, async () => key);
  const concurrent = Array.from({ length: 20 }, () => cache.get("slow", 60, () => assert.fail("pending key was evicted")));
  gate.resolve("slow result");
  const observation = await first;
  assert.ok((await Promise.all(concurrent)).every(result => result === observation));
  assert.equal((await cache.get("a", 60, async () => "a reloaded")).value, "a reloaded", "completed observations still have a retention bound");
});

test("both synchronous and asynchronous failures reach every waiter and allow immediate retry", async () => {
  for (const synchronous of [true, false]) {
    const cache = new DataCache();
    const failure = new Error("fixture upstream failure");
    let calls = 0;
    const first = cache.get("failed", 60, () => {
      calls++;
      if (synchronous) throw failure;
      return Promise.reject(failure);
    });
    const waiter = cache.get("failed", 60, () => assert.fail("failure waiter started another loader"));
    const results = await Promise.allSettled([first, waiter]);
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.status === "rejected" && result.reason === failure));
    assert.equal((await cache.get("failed", 60, async () => "recovered")).value, "recovered");
  }
});

test("a failed loader releases admission capacity without starting previously rejected work", async () => {
  const cache = new DataCache();
  const gates = Array.from({ length: DATA_CACHE_MAX_IN_FLIGHT }, deferred);
  const active = gates.map((gate, i) => cache.get(`active:${i}`, 60, () => gate.promise));
  const settled = Promise.allSettled(active);
  let refusedCalls = 0;
  await assert.rejects(cache.get("refused", 60, async () => { refusedCalls++; return "unexpected"; }), DataCacheOverloadError);
  gates[0].reject(new Error("fixture failure"));
  await assert.rejects(active[0], /fixture failure/);
  assert.equal(refusedCalls, 0);
  assert.equal((await cache.get("refused", 60, async () => { refusedCalls++; return "explicit retry"; })).value, "explicit retry");
  assert.equal(refusedCalls, 1);
  for (const gate of gates.slice(1)) gate.resolve("fixture");
  await settled;
});

test("fetcher cancellation propagates to shared waiters without retaining a failed entry", async () => {
  const cache = new DataCache();
  const controller = new AbortController();
  const cancellation = new Error("fixture cancellation");
  const gate = deferred();
  const first = cache.get("cancelled", 60, () => {
    controller.signal.addEventListener("abort", () => gate.reject(controller.signal.reason), { once: true });
    return gate.promise;
  });
  const waiter = cache.get("cancelled", 60, () => assert.fail("cancelled waiter started another loader"));
  const settled = Promise.allSettled([first, waiter]);
  await Promise.resolve();
  controller.abort(cancellation);
  assert.ok((await settled).every(result => result.status === "rejected" && result.reason === cancellation));
  assert.equal((await cache.get("cancelled", 60, async () => "retry")).value, "retry");
});

test("TTL starts at successful completion, retains timestamps on hits, and refreshes at expiry", async () => {
  let now = 1000;
  const cache = new DataCache(2, () => now);
  const gate = deferred();
  const first = cache.get("timed", 60, () => gate.promise);
  now = 100_000;
  gate.resolve("old");
  const observation = await first;
  assert.equal(observation.fetchedAt, new Date(now).toISOString());
  assert.equal(observation.expiresAt, new Date(160_000).toISOString());
  now = 159_999;
  assert.strictEqual(await cache.get("timed", 60, () => assert.fail("unexpired observation reloaded")), observation);
  now = 160_000;
  const refreshed = await cache.get("timed", 60, async () => "new");
  assert.equal(refreshed.value, "new");
  assert.equal(refreshed.fetchedAt, new Date(now).toISOString());
});

test("public stats sanitizes overload, serves cached hits and shared waiters, then recovers", async () => {
  const cache = new DataCache();
  const gates = new Map();
  let calls = 0;
  const service = createPublicDataService({ getGameStats: async ([id]) => {
    calls++;
    if (id === 1 || id === 1000) return [];
    const gate = deferred();
    gates.set(id, gate);
    return gate.promise;
  } }, cache);
  const handler = createPublicHttpHandler("stats", service);
  const request = id => new Request(`https://fixture.invalid/api/public/stats?universeIds=${id}`);
  assert.equal((await handler(request(1))).status, 200);
  const pending = Array.from({ length: DATA_CACHE_MAX_IN_FLIGHT }, (_, i) => handler(request(i + 2)));
  const waiter = handler(request(2));
  const excess = await handler(request(1000));
  assert.equal(excess.status, 503);
  assert.deepEqual(await excess.json(), { error: "Couldn't retrieve public data. Try again." });
  assert.equal(excess.headers.get("cache-control"), "no-store");
  assert.equal((await handler(request(1))).status, 200, "a cached hit needs no active slot");
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT + 1);
  gates.get(2).resolve([]);
  assert.deepEqual(await (await waiter).json(), await (await pending[0]).json());
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT + 1, "overloaded work was not queued");
  assert.equal((await handler(request(1000))).status, 200);
  assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT + 2);
  for (const gate of gates.values()) gate.resolve([]);
  assert.ok((await Promise.all(pending)).every(response => response.status === 200));
});
