import test from "node:test";
import assert from "node:assert/strict";
import { collectorAuthorized, dispatchCollection, retryCollectionRead } from "../src/lib/history/scheduled.ts";
import worker from "../netlify/functions/history-collect-background.ts";

const token = "test-only-collector-credential-at-least-32-characters";
const env = { HISTORY_COLLECTOR_TOKEN: token, HISTORY_COLLECTOR_ORIGIN: "https://romanum.example" };

test("only authenticated POST requests authorize collection; rejected work needs no database", async () => {
  const request = (method = "POST", auth = `Bearer ${token}`) => new Request("https://romanum.example/worker", { method, headers: { authorization: auth } });
  assert.equal(collectorAuthorized(request(), env), true);
  assert.equal(collectorAuthorized(request("GET"), env), false);
  assert.equal(collectorAuthorized(request("POST", "Bearer wrong"), env), false);
  assert.equal(collectorAuthorized(request(), {}), false);
  assert.equal(collectorAuthorized(request(), { HISTORY_COLLECTOR_TOKEN: "short" }), false);
  await worker(new Request("https://romanum.example/worker", { method: "POST" }));
});

test("timer dispatch is bounded, authenticated and cannot redirect its secret", async () => {
  await dispatchCollection(env, async (url, init) => {
    assert.equal(url.href, "https://romanum.example/.netlify/functions/history-collect-background");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.ok(init.signal);
    return new Response(null, { status: 202 });
  });
  await assert.rejects(dispatchCollection(env, async () => new Response(null, { status: 500 })), /not accepted/);
  const noFetch = async () => assert.fail("invalid configuration made a request");
  await assert.rejects(dispatchCollection({}, noFetch));
  for (const origin of ["http://romanum.example", "https://user:pass@romanum.example", "https://romanum.example/path", "https://romanum.example/?redirect=other"]) {
    await assert.rejects(dispatchCollection({ ...env, HISTORY_COLLECTOR_ORIGIN: origin }, noFetch));
  }
});

test("transient collection reads retry once but persistent failures stay failures", async () => {
  let reads = 0;
  const sleeps = [];
  assert.equal(await retryCollectionRead(async () => { if (++reads === 1) throw new Error("offline"); return "fresh"; }, async (ms) => { sleeps.push(ms); }), "fresh");
  assert.equal(reads, 2);
  assert.deepEqual(sleeps, [1000]);
  reads = 0;
  await assert.rejects(retryCollectionRead(async () => { reads++; throw new Error("offline"); }, async () => {}), /offline/);
  assert.equal(reads, 2);
});
