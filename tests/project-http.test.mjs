import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { projectResponse } from "../src/lib/projects/http.ts";

const input = { name: "My game", context: { game: "My game" } };
const request = (method = "GET", body, query = "") => new Request(`https://romanum.test/api/projects${query}`, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
const deps = (db, ownerId = "account:a") => ({ account: async () => ownerId ? { ownerId } : null, database: async () => db, isCrossSite: () => false });
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

test("project endpoints require an account, reject cross-site mutations and fail privately", async () => {
  const unavailable = { ...deps(null), database: async () => { throw new Error("private connection string"); } };
  for (const method of ["GET", "POST", "PUT"]) {
    const response = await projectResponse(request(method, method === "GET" ? undefined : input), { ...unavailable, account: async () => null });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await projectResponse(request("POST", input), { ...unavailable, isCrossSite: () => true })).status, 403);
  const error = await projectResponse(request(), unavailable);
  assert.equal(error.status, 503);
  assert.ok(!(await error.text()).includes("connection string"));
});

test("project HTTP create/read/update/archive round trip excludes other owners and stale edits", async (t) => {
  const db = await database(t);
  const mine = deps(db);
  const other = deps(db, "account:b");
  const created = await projectResponse(request("POST", input), mine);
  assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal(project.revision, 1);
  assert.equal(project.context.gameplay, "");
  assert.equal((await projectResponse(request(), mine, project.id)).status, 200);
  assert.equal((await projectResponse(request(), other, project.id)).status, 404);
  assert.deepEqual((await (await projectResponse(request(), other)).json()).projects, []);
  const body = { ...input, revision: 1, archived: true };
  assert.equal((await projectResponse(request("PUT", body), other, project.id)).status, 404);
  assert.equal((await projectResponse(request("PUT", body), mine, project.id)).status, 200);
  assert.equal((await projectResponse(request("PUT", body), mine, project.id)).status, 409);
  assert.deepEqual((await (await projectResponse(request(), mine)).json()).projects, []);
  const archived = await projectResponse(request("GET", undefined, "?archived=true"), mine);
  assert.deepEqual((await archived.json()).projects.map((p) => p.id), [project.id]);
  assert.equal((await projectResponse(request("PUT", { ...body, revision: 2, archived: false }), mine, project.id)).status, 200);
});

test("project HTTP bounds actual streamed bytes and refuses identity injection and malformed JSON", async (t) => {
  const db = await database(t);
  const mine = deps(db);
  for (const body of ["{", { ...input, ownerId: "account:b" }, { ...input, context: { game: "Game", ownerId: "account:b" } }]) {
    assert.equal((await projectResponse(request("POST", body), mine)).status, 400);
  }
  // No Content-Length is required or trusted for the bounded JSON reader.
  assert.equal((await projectResponse(request("POST", " ".repeat(196_609)), mine)).status, 413);
  assert.equal((await projectResponse(new Request("https://romanum.test/api/projects", { method: "POST", body: JSON.stringify(input) }), mine)).status, 400);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_projects")).rows[0].count, 0);
});
