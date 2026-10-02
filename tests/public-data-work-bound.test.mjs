import test from "node:test";
import assert from "node:assert/strict";
import { DataCache, DATA_CACHE_MAX_IN_FLIGHT } from "../src/lib/data-cache.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { createPublicHttpHandler } from "../src/lib/public-http.ts";
import { getGameStats } from "../src/lib/roblox.ts";

const request = (id, signal) => new Request(`https://fixture.invalid/api/public/stats?universeIds=${id}`, { signal });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("aborted public callers and duplicate waiters retain capacity until underlying loaders finish", async () => {
  const gates = [];
  let active = 0, peak = 0, calls = 0;
  const handler = createPublicHttpHandler("stats", createPublicDataService({ getGameStats: async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const gate = Promise.withResolvers();
    gates.push(gate);
    try { return await gate.promise; } finally { active--; }
  } }, new DataCache()));
  const controllers = Array.from({ length: DATA_CACHE_MAX_IN_FLIGHT }, () => new AbortController());
  const pending = controllers.map((controller, i) => handler(request(i + 1, controller.signal)));
  const waiterController = new AbortController();
  const waiter = handler(request(1, waiterController.signal));
  try {
    await flush();
    assert.equal(active, DATA_CACHE_MAX_IN_FLIGHT);
    for (const controller of [...controllers, waiterController]) controller.abort();
    const excess = await Promise.all(Array.from({ length: 64 }, (_, i) => handler(request(i + 1000))));
    assert.ok(excess.every(response => response.status === 503));
    assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT, "abandoned callers must not admit replacement work");
    assert.equal(active, DATA_CACHE_MAX_IN_FLIGHT, "measure running loaders, not cache bookkeeping");
  } finally {
    for (const gate of gates) gate.resolve([]);
    await Promise.all([...pending, waiter]);
  }
  assert.equal(active, 0);
  assert.equal(peak, DATA_CACHE_MAX_IN_FLIGHT);
});

test("one failed stats request cannot free its loader slot while sibling upstream requests still run", async () => {
  const originalFetch = globalThis.fetch;
  const gates = [];
  const failure = new Error("fixture early metadata failure");
  let calls = 0, active = 0, peak = 0, completed = 0;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    calls++;
    active++;
    peak = Math.max(peak, active);
    let work;
    if (url.hostname === "games.roblox.com" && url.pathname === "/v1/games") {
      work = Promise.reject(failure);
    } else {
      assert.ok((url.hostname === "games.roblox.com" && url.pathname === "/v1/games/votes") ||
        (url.hostname === "thumbnails.roblox.com" && url.pathname === "/v1/games/icons"));
      const gate = Promise.withResolvers();
      gates.push(gate);
      work = gate.promise;
    }
    return work.finally(() => { active--; });
  };
  const handler = createPublicHttpHandler("stats", createPublicDataService({ getGameStats }, new DataCache()));
  const controllers = Array.from({ length: DATA_CACHE_MAX_IN_FLIGHT }, () => new AbortController());
  const pending = controllers.map((controller, i) => handler(request(i + 1, controller.signal)).then(response => {
    completed++;
    return response;
  }));
  let excess = [];
  try {
    await flush();
    for (const controller of controllers) controller.abort();
    excess = Array.from({ length: DATA_CACHE_MAX_IN_FLIGHT }, (_, i) => handler(request(i + 1000)));
    assert.ok((await Promise.all(excess)).every(response => response.status === 503));
    assert.equal(calls, DATA_CACHE_MAX_IN_FLIGHT * 3, "refused lookups must not start sibling upstream work");
    assert.equal(completed, 0, "the failed aggregate must retain its slot until all sibling work settles");
    assert.equal(active, DATA_CACHE_MAX_IN_FLIGHT * 2);
    assert.ok(peak <= DATA_CACHE_MAX_IN_FLIGHT * 3);
  } finally {
    for (const gate of gates) gate.resolve(Response.json({ data: [] }));
    await Promise.all([...pending, ...excess]);
    globalThis.fetch = originalFetch;
  }
  assert.equal(active, 0);
  assert.ok((await Promise.all(pending)).every(response => response.status === 503));
});
