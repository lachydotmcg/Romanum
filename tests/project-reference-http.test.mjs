import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject } from "../src/lib/projects/store.ts";
import { referenceResponse } from "../src/lib/projects/reference-http.ts";
import { saveQuestion, readAttachment, questionForModel } from "../src/lib/chats/store.ts";
import { withReferenceImages } from "../src/lib/chats/vision.ts";

const origin = "https://romanum.test", ownerId = "owner:reference-http";
const metadata = { label: "Inventory reference", rights: "owned", rightsNote: "Original UI" };
const deps = (db, owner = ownerId) => ({ account: async () => owner ? { ownerId: owner } : null, database: async () => db, origin: () => origin });
const image = () => sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 0.5 } } }).png().withExif({ IFD0: { Artist: "Private author" } }).toBuffer();
const upload = async (extra = {}, overrides = {}) => {
  const form = new FormData();
  form.set("file", new File([await image()], "original.png", { type: "image/png" }));
  form.set("metadata", JSON.stringify({ ...metadata, ...extra }));
  return new Request(`${origin}/api/projects/test/references`, { method: "POST", headers: { origin }, body: form, ...overrides });
};
const read = () => new Request(`${origin}/api/projects/test/references`);
const remove = () => new Request(`${origin}/api/projects/test/references/test`, { method: "DELETE", headers: { origin } });

async function database(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db); return db;
}

test("reference HTTP requires sign-in and origin checks before touching storage", async () => {
  const dependencies = { ...deps(null), database: async () => assert.fail("storage must not open") };
  for (const headers of [{ origin: "https://other.test" }, {}, { origin, "sec-fetch-site": "cross-site" }]) {
    const response = await referenceResponse(await upload({}, { headers }), dependencies, randomUUID());
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const request of [read(), await upload(), remove()]) assert.equal((await referenceResponse(request, deps(null, null), randomUUID(), request.method === "DELETE" ? randomUUID() : undefined)).status, 401);
  assert.equal((await referenceResponse(new Request(origin, { method: "PUT" }), dependencies, randomUUID())).status, 405);
});

test("uploads bound actual stream bytes and reject duplicate or injected multipart fields", async t => {
  const db = await database(t), project = await createProject(db, { ownerId, name: "HTTP limits", context: { game: "Test" } });
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65_536)); }, cancel() { cancelled = true; } });
  const oversized = new Request(origin, { method: "POST", headers: { origin, "content-type": "multipart/form-data; boundary=test" }, body: stream, duplex: "half" });
  assert.equal((await referenceResponse(oversized, deps(db), project.id)).status, 413);
  assert.equal(cancelled, true);
  for (const mutate of [form => form.append("file", new File(["extra"], "extra.png")), form => form.set("ownerId", "other"), form => form.append("metadata", "{}"), form => form.set("metadata", "{")]) {
    const form = await (await upload()).formData(); mutate(form);
    const request = new Request(origin, { method: "POST", headers: { origin }, body: form });
    assert.equal((await referenceResponse(request, deps(db), project.id)).status, 400);
  }
  assert.equal((await referenceResponse(await upload({ performance: { ctr: 90 } }), deps(db), project.id)).status, 400);
  assert.equal((await db.query("SELECT 1 FROM creative_assets")).rows.length, 0);
});

test("an owned reference becomes actual chat vision input, while its stored chat copy survives library removal", async t => {
  const db = await database(t), project = await createProject(db, { ownerId, name: "Reference project", context: { game: "Test" } });
  const posted = await referenceResponse(await upload(), deps(db), project.id);
  assert.equal(posted.status, 201);
  const { reference } = await posted.json();
  const listed = await referenceResponse(read(), deps(db), project.id);
  assert.deepEqual((await listed.json()).references.map(item => item.id), [reference.id]);
  for (const [owner, projectId] of [["owner:other", project.id], [ownerId, randomUUID()]]) {
    assert.equal((await referenceResponse(read(), deps(db, owner), projectId, reference.id)).status, 404);
    assert.equal((await referenceResponse(remove(), deps(db, owner), projectId, reference.id)).status, 404);
  }
  const fetched = await referenceResponse(read(), deps(db), project.id, reference.id);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.equal(fetched.headers.get("cache-control"), "no-store");
  assert.equal(fetched.headers.get("vary"), "Cookie");
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  assert.equal((await sharp(bytes).metadata()).exif, undefined);
  // Same bytes the picker downloads and includes as a File in a chat submission.
  const saved = await saveQuestion(db, { ownerId, chatId: null, projectId: project.id, question: "Review this UI", attachments: [{ name: `${reference.label}.png`, bytes }] });
  const input = withReferenceImages(questionForModel(saved.question, saved.attachments.map(item => item.name)), saved.images);
  assert.equal(input.content[1].image_url.url, `data:image/webp;base64,${Buffer.from(saved.images[0].bytes).toString("base64")}`);
  assert.ok(await readAttachment(db, ownerId, saved.attachments[0].id));
  assert.equal((await referenceResponse(remove(), deps(db), project.id, reference.id)).status, 200);
  assert.equal((await referenceResponse(read(), deps(db), project.id, reference.id)).status, 404);
  assert.ok(await readAttachment(db, ownerId, saved.attachments[0].id));
  assert.equal(await readAttachment(db, "owner:other", saved.attachments[0].id), null);
  for (const table of ["credits_operations", "usage_holds", "creative_jobs", "ui_asset_rights", "ui_library_entries"]) assert.equal((await db.query(`SELECT 1 FROM ${table}`)).rows.length, 0);
});

test("reference HTTP conceals storage failures", async () => {
  const response = await referenceResponse(read(), { ...deps(null), database: async () => { throw new Error("postgres://private:secret@database"); } }, randomUUID());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /postgres|secret|private/);
});
