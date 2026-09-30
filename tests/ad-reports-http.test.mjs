import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject } from "../src/lib/projects/store.ts";
import { CANONICAL_DAILY_HEADER } from "../src/lib/ad-reports/import.ts";
import { adReportsResponse } from "../src/lib/ad-reports/http.ts";
const origin = "https://romanum.test", ownerId = "owner:ad-http";
const context = { periodStart: "2026-01-01", periodEnd: "2026-01-02", timezone: "UTC", attributionWindow: null, placement: null, audience: null, currency: null };
const values = { date: "2026-01-01", campaignId: "c1", campaignName: "Invented campaign", adId: "a1", adName: "Invented ad", universeId: "999", objective: "Plays", adFormat: "Image", impressions: "1000", clicks: "50", plays: "10", spend: "20", paymentType: "Ad Credit" };
const csv = `${CANONICAL_DAILY_HEADER.join(",")}\n${CANONICAL_DAILY_HEADER.map(key => values[key] ?? "").join(",")}\n`;
const deps = (db, owner = ownerId) => ({ account: async () => owner ? { ownerId: owner } : null, database: async () => db, origin: () => origin });
const read = () => new Request(origin);
const action = (body, headers = {}) => new Request(origin, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const upload = (mutate = () => {}, headers = { origin }) => { const form = new FormData(); form.set("file", new File([csv], "Romanum_Daily_v1_Ads_AllUsers.csv")); form.set("context", JSON.stringify(context)); mutate(form); return new Request(origin, { method: "POST", headers, body: form }); };
async function database(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() }; await migrateHistory(db); return db;
}
test("HTTP requires session and exact same origin before opening storage; no-store on failures", async () => {
  const unopened = { ...deps(null), database: async () => assert.fail("storage opened") };
  for (const headers of [{}, { origin: "https://evil.test" }, { origin, "sec-fetch-site": "cross-site" }]) {
    const response = await adReportsResponse(upload(undefined, headers), unopened, randomUUID()); assert.equal(response.status, 403); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const request of [read(), upload(), action({ action: "delete", reportId: randomUUID() })]) assert.equal((await adReportsResponse(request, deps(null, null), randomUUID())).status, 401);
  assert.equal((await adReportsResponse(new Request(origin, { method: "DELETE" }), unopened, randomUUID())).status, 405);
});
test("owner imports/list/consent/manual observations/delete require no API key", async t => {
  const db = await database(t), own = await createProject(db, { ownerId, name: "Invented", context: { game: "Test" } });
  const imported = await adReportsResponse(upload(), deps(db), own.id); assert.equal(imported.status, 201);
  const { report } = await imported.json();
  const duplicate = await adReportsResponse(upload(), deps(db), own.id); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
  const get = await adReportsResponse(read(), deps(db), own.id); assert.equal(get.status, 200); assert.equal(get.headers.get("vary"), "Cookie"); assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await get.json()).reports[0].id, report.id);
  assert.equal((await adReportsResponse(read(), deps(db, "other"), own.id)).status, 404);
  const consent = await adReportsResponse(action({ action: "consent", aiAnalysis: true, consentVersion: 0 }), deps(db), own.id); assert.equal(consent.status, 200); assert.equal((await consent.json()).settings.consentVersion, 1);
  assert.equal((await adReportsResponse(action({ action: "consent", aiAnalysis: false, consentVersion: 0 }), deps(db), own.id)).status, 409);
  assert.equal((await adReportsResponse(action({ action: "observation", text: "Owner hypothesis", status: "hypothesis", reportIds: [report.id] }), deps(db), own.id)).status, 201);
  const deleted = await adReportsResponse(action({ action: "delete", reportId: report.id }), deps(db), own.id); assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).dependentObservationsDeleted, true);
  const empty = await (await adReportsResponse(read(), deps(db), own.id)).json(); assert.deepEqual(empty.reports, []); assert.deepEqual(empty.observations, []);
});
test("actual stream/file/JSON limits and multipart/JSON shapes reject before writing", async t => {
  const db = await database(t), own = await createProject(db, { ownerId, name: "Limits", context: { game: "Test" } });
  for (const mutate of [form => form.append("file", new File([csv], "extra.csv")), form => form.append("context", "{}"), form => form.set("ownerId", "other"), form => form.set("context", "{"), form => form.set("context", JSON.stringify({ ...context, aiAnalysis: true })), form => form.set("file", new File(["arbitrary headers\n1\n"], "arbitrary.csv"))]) assert.equal((await adReportsResponse(upload(mutate), deps(db), own.id)).status, 400);
  assert.equal((await adReportsResponse(upload(form => form.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.zip"))), deps(db), own.id)).status, 413);
  assert.equal((await adReportsResponse(action({ action: "consent", aiAnalysis: true, consentVersion: 0, platformImprovement: true }), deps(db), own.id)).status, 400);
  for (const contentType of ["application/json", "multipart/form-data; boundary=fixture"]) {
    let cancelled = false; const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65_536)); }, cancel() { cancelled = true; } });
    const request = new Request(origin, { method: "POST", headers: { origin, "content-type": contentType }, body: stream, duplex: "half" });
    assert.equal((await adReportsResponse(request, deps(db), own.id)).status, 413); assert.equal(cancelled, true);
  }
  assert.equal((await db.query("SELECT count(*)::int AS count FROM ad_reports")).rows[0].count, 0);
});
test("storage errors do not reveal diagnostics or credentials", async () => {
  const result = await adReportsResponse(read(), { ...deps(null), database: async () => { throw new Error("postgres://private:secret@internal"); } }, randomUUID());
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /secret|postgres|internal/);
});
