import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { databaseImageLibraryStorage } from "../src/lib/image-library/storage.ts";
import { imageLibraryResponse } from "../src/lib/image-library/http.ts";
import { ImageLibraryInputError, parseImageLibraryQuery } from "../src/lib/image-library/query.ts";

// Isolated in-memory persistence and local synthetic PNGs. No live account, storage or provider.
const OWNER = "library-fixture-owner";
const OTHER = "other-fixture-owner";
let db, engine, storage, png, project, foreignProject, own, foreign, copy;
const queries = [];
const request = (query = "", options) => new Request(`https://fixture.invalid/api/image-library${query}`, options);
const deps = (owner = OWNER, adapter = storage) => ({ account: async () => owner ? { ownerId: owner } : null, storage: async () => adapter, origin: () => "https://fixture.invalid" });
const query = (text = "", owner = OWNER) => parseImageLibraryQuery(new URLSearchParams(text), owner);

async function asset(ownerId, projectId, title, { kind = "generated", lineage = false, flowKind = "thumbnail", stage = "final", prompt = "Private fixture prompt", time = "2026-10-02T12:00:00.123456Z" } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata,created_at)
    VALUES($1,$2,$3,$4,$5,'image/png',768,512,$6,$7,$8)`,
  [id, ownerId, projectId, kind, png, createHash("sha256").update(png).digest("hex"), JSON.stringify({ label: title, rawStorageUrl: "https://private.invalid/secret-token", receipt: "private-receipt", operatorNote: "private-operator-note" }), time]);
  if (lineage) {
    const workflow = randomUUID();
    await db.query(`INSERT INTO creative_workflows(id,owner_id,project_id,kind,brief,concepts,credit_budget)
      VALUES($1,$2,$3,$4,'{}',$5,10)`, [workflow, ownerId, projectId, flowKind, JSON.stringify([{ key: "fixture", title }])]);
    await db.query(`INSERT INTO creative_jobs(id,owner_id,project_id,workflow_id,concept_key,stage,status,provider_id,provider_model,provider_mode,quoted_credits,request,output_asset_id,provider_request_id)
      VALUES($1,$2,$3,$4,'fixture',$5,'succeeded','fixture-provider','fixture-model','test',1,$6,$7,'private-provider-receipt')`,
    [randomUUID(), ownerId, projectId, workflow, stage, JSON.stringify({ prompt, referenceIds: [] }), id]);
  }
  return id;
}

test.before(async () => {
  engine = await PGlite.create();
  db = { query: (text, values) => { queries.push(text); return engine.query(text, values); }, exec: text => engine.exec(text) };
  await db.exec(await readFile(new URL("../db/migrations/003_creative_workflows.sql", import.meta.url), "utf8"));
  png = await sharp({ create: { width: 768, height: 512, channels: 4, background: { r: 55, g: 77, b: 99, alpha: 0.7 } } }).png().toBuffer();
  project = randomUUID(); foreignProject = randomUUID();
  for (const [id, owner, name] of [[project, OWNER, "Fixture project"], [foreignProject, OTHER, "Other private project"]]) {
    await db.query("INSERT INTO creative_projects(id,owner_id,name,context) VALUES($1,$2,$3,'{}')", [id, owner, name]);
  }
  own = await asset(OWNER, project, "Fixture thumbnail", { lineage: true });
  foreign = await asset(OTHER, foreignProject, "Other private image", { lineage: true, prompt: "Other owner's secret prompt" });
  copy = await asset(OWNER, project, "Saved generated copy");
  await asset(OWNER, project, "Project reference must stay excluded", { kind: "reference" });
  storage = databaseImageLibraryStorage(db);
});
test.after(async () => { await engine?.close(); });

test("list and detail expose only owned generated images and allowlisted generation metadata", async () => {
  const page = await storage.list(OWNER, query());
  assert.deepEqual(new Set(page.images.map(image => image.id)), new Set([own, copy]));
  assert.ok(!page.images.some(image => image.id === foreign));
  const recorded = await storage.detail(OWNER, own);
  assert.equal(recorded.prompt, "Private fixture prompt");
  assert.deepEqual(recorded.generation, { kind: "thumbnail", stage: "final", provider: "fixture-provider", model: "fixture-model", mode: "test" });
  assert.equal((await storage.detail(OWNER, copy)).generation.model, null);
  assert.equal((await storage.detail(OWNER, copy)).prompt, null);
  const json = JSON.stringify({ page, recorded });
  for (const privateField of [OTHER, "Other private", "Other owner's secret", "rawStorageUrl", "private.invalid", "secret-token", "receipt", "private-operator-note", "owner_id", "sha256", "bytes"]) assert.ok(!json.includes(privateField), privateField);
  assert.ok(!("prompt" in page.images[0]));
  assert.equal(await storage.detail(OWNER, foreign), null);
  assert.equal(await storage.detail(OTHER, own), null);
  assert.deepEqual(await storage.file(OTHER, own), { status: "missing" });
  assert.ok(queries.filter(sql => /FROM creative_assets/.test(sql)).every(sql => sql.includes("a.owner_id=$1") && sql.includes("p.owner_id=$1")));
});

test("open, download and thumbnail requests recheck ownership and serve bounded private PNGs", async () => {
  const open = await imageLibraryResponse(request(), deps(), own, true);
  assert.equal(open.status, 200);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), png);
  assert.equal(open.headers.get("cache-control"), "private, no-store");
  assert.equal(open.headers.get("vary"), "Cookie");
  assert.equal(open.headers.get("content-type"), "image/png");
  assert.equal(open.headers.get("x-content-type-options"), "nosniff");
  assert.equal(open.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.match(open.headers.get("content-disposition"), /^inline; filename="[a-f0-9-]+\.png"$/);
  const download = await imageLibraryResponse(request("?download=1"), deps(), own, true);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  const thumbnail = await imageLibraryResponse(request("?variant=thumbnail"), deps(), own, true);
  const shape = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  assert.equal(thumbnail.status, 200);
  assert.equal(shape.width, 512);
  assert.ok(shape.height <= 512);
  assert.equal((await imageLibraryResponse(request(), deps(OTHER), own, true)).status, 404);
  assert.equal((await imageLibraryResponse(request(), deps(), foreign, true)).status, 404);
});

test("literal search, type/stage/project filters and keyset pagination remain bounded and owner scoped", async () => {
  const ui = await asset(OWNER, project, "Fixture UI card", { lineage: true, flowKind: "ui", stage: "asset" });
  const special = await asset(OWNER, project, "Literal %_ marker");
  const pageIds = [];
  for (let i = 0; i < 29; i++) pageIds.push(await asset(OWNER, project, `Paged image ${i}`, { time: `2026-10-02T13:00:00.${String(100000 + i).padStart(6, "0")}Z` }));
  assert.equal((await storage.list(OWNER, query("q=%25_"))).images[0].id, special);
  assert.deepEqual((await storage.list(OWNER, query("kind=ui&stage=asset"))).images.map(image => image.id), [ui]);
  assert.equal((await storage.list(OWNER, query("q=fixture-model"))).images.length, 2);
  assert.deepEqual((await storage.list(OWNER, query(`projectId=${foreignProject}`))).images, []);
  const seen = [];
  let cursor;
  do {
    const params = new URLSearchParams({ q: "Paged image", limit: "4" });
    if (cursor) params.set("cursor", cursor);
    const page = await storage.list(OWNER, parseImageLibraryQuery(params, OWNER));
    assert.ok(page.images.length <= 4);
    seen.push(...page.images.map(image => image.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 29);
  assert.equal(new Set(seen).size, 29, "microsecond pagination cannot repeat or skip images");
  assert.deepEqual(new Set(seen), new Set(pageIds));
  assert.equal((await storage.list(OWNER, query("q=Paged image&limit=24"))).images.length, 24);
  const first = await storage.list(OWNER, query("q=Paged image&limit=4"));
  for (const params of [new URLSearchParams({ q: "Paged image", limit: "4", cursor: first.nextCursor }), new URLSearchParams({ q: "another search", limit: "4", cursor: first.nextCursor })]) {
    assert.throws(() => parseImageLibraryQuery(params, OTHER), ImageLibraryInputError);
  }
});

test("invalid filters, IDs and pagination are refused before storage; unauthenticated/expired sessions read nothing", async () => {
  const never = { account: async () => ({ ownerId: OWNER }), storage: async () => assert.fail("invalid input reached storage"), origin: () => "https://fixture.invalid" };
  for (const input of ["?ownerId=other", "?__proto__=other", "?constructor=other", "?q=a&q=b", `?q=${"x".repeat(81)}`, "?limit=0", "?limit=25", "?limit=01", "?limit=1.5", "?kind=reference", "?stage=running", "?projectId=bad", "?cursor=bad", "?cursor=", `?q=${"x".repeat(2100)}`]) {
    assert.equal((await imageLibraryResponse(request(input), never)).status, 400, input.slice(0, 80));
  }
  for (const id of ["bad", "../../private", "00000000-0000-0000-0000-000000000000' OR 1=1"]) {
    assert.equal((await imageLibraryResponse(request(), never, id)).status, 404);
    assert.equal((await imageLibraryResponse(request(), never, id, true)).status, 404);
  }
  const expiredSession = { ...never, account: async () => null };
  for (const [id, file] of [[undefined, false], [own, false], [own, true]]) assert.equal((await imageLibraryResponse(request(), expiredSession, id, file)).status, 401);
  await assert.rejects(storage.list(OWNER, { ...query(), limit: 100000 }), ImageLibraryInputError);
  assert.equal(await storage.detail(OWNER, "invalid"), null);
  assert.deepEqual(await storage.file(OWNER, "invalid"), { status: "missing" });
});

test("metadata and file requests resolve the current owner every time and reject foreign/non-GET reads", async () => {
  let currentOwner = OWNER, accountCalls = 0;
  const current = { ...deps(), account: async () => { accountCalls++; return { ownerId: currentOwner }; } };
  assert.equal((await imageLibraryResponse(request(), current, own)).status, 200);
  currentOwner = OTHER;
  assert.equal((await imageLibraryResponse(request(), current, own)).status, 404);
  assert.equal((await imageLibraryResponse(request(), current, own, true)).status, 404);
  assert.equal(accountCalls, 3);
  const never = { ...deps(), account: async () => assert.fail("rejected request reached account") };
  assert.equal((await imageLibraryResponse(request("", { method: "POST" }), never)).status, 405);
  assert.equal((await imageLibraryResponse(request("", { headers: { origin: "https://other.invalid" } }), never)).status, 403);
  assert.equal((await imageLibraryResponse(request("", { headers: { "sec-fetch-site": "cross-site" } }), never)).status, 403);
  for (const input of ["?download=0", "?variant=original", "?variant=thumbnail&download=1", "?download=1&download=1", "?storageUrl=https://private.invalid"]) assert.equal((await imageLibraryResponse(request(input), deps(), own, true)).status, 400);
  assert.equal((await imageLibraryResponse(request("?ownerId=other"), deps(), own)).status, 400);
});

test("missing and expired file outcomes are private and cannot reveal foreign asset existence", async () => {
  for (const [status, expected] of [["missing", 404], ["expired", 410]]) {
    let fileCalls = 0;
    const adapter = { ...storage, file: async () => { fileCalls++; return { status }; } };
    assert.equal((await imageLibraryResponse(request(), deps(OWNER, adapter), own, true)).status, expected);
    assert.equal((await imageLibraryResponse(request(), deps(OWNER, adapter), foreign, true)).status, 404);
    assert.equal(fileCalls, 1, "file outcome must be consulted only after owned metadata");
  }
  assert.equal(await storage.detail(OWNER, randomUUID()), null);
  const corrupt = await asset(OWNER, project, "Corrupt fixture");
  await db.query("UPDATE creative_assets SET sha256='incorrect' WHERE id=$1", [corrupt]);
  assert.deepEqual(await storage.file(OWNER, corrupt), { status: "missing" });
});

test("empty libraries are successful, storage failures are explicitly unavailable and secrets stay hidden", async () => {
  const empty = await imageLibraryResponse(request(), deps("empty-owner"));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { status: "ready", images: [], nextCursor: null });
  for (const adapter of [null, { list: async () => { throw new Error("postgres://private-secret SELECT private_accounts"); } }]) {
    const response = await imageLibraryResponse(request(), deps(OWNER, adapter));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable", error: "Image library unavailable. Try again later." });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("invalid envelopes and undecodable previews are missing files while storage failures remain unavailable", async () => {
  const broken = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(broken);
  broken.writeUInt32BE(13, 8); broken.write("IHDR", 12);
  broken.writeUInt32BE(768, 16); broken.writeUInt32BE(512, 20); broken.write("IEND", 37);
  for (const bytes of [new Uint8Array(45), broken]) {
    const adapter = { ...storage, file: async () => ({ status: "ready", bytes, mimeType: "image/png" }) };
    const response = await imageLibraryResponse(request("?variant=thumbnail"), deps(OWNER, adapter), own, true);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "Image not found." });
  }
  const adapter = { ...storage, file: async () => { throw new Error("private storage unavailable"); } };
  assert.equal((await imageLibraryResponse(request("?variant=thumbnail"), deps(OWNER, adapter), own, true)).status, 503);
});

test("saved prompts remain owner-only and are bounded independently of list metadata", async () => {
  const id = await asset(OWNER, project, "Long private prompt", { lineage: true, prompt: "p".repeat(9000) });
  const detail = await storage.detail(OWNER, id);
  assert.equal(detail.prompt.length, 8000);
  assert.equal(detail.promptTruncated, true);
  const response = await imageLibraryResponse(request(), deps(), id);
  assert.equal((await response.json()).image.prompt.length, 8000);
  assert.equal((await imageLibraryResponse(request(), deps(OTHER), id)).status, 404);
});

test("model search includes saved copies whose recorded model is in asset metadata", async () => {
  const id = await asset(OWNER, project, "Generated copy with recorded model");
  await db.query("UPDATE creative_assets SET metadata=metadata || $2::jsonb WHERE id=$1", [id, JSON.stringify({ model: "copied-model" })]);
  assert.equal((await storage.detail(OWNER, id)).generation.model, "copied-model");
  assert.deepEqual((await storage.list(OWNER, query("q=copied-model"))).images.map(image => image.id), [id]);
  assert.deepEqual((await storage.list(OTHER, query("q=copied-model", OTHER))).images, []);
});
