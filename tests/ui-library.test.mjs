import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createCreativeProject, addCreativeReference, readCreativeAsset, insertAsset } from "../src/lib/creative/storage.ts";
import { createUiEntry, updateUiEntry, readPrivateUiEntry, declareUiAssetRights, shareUiEntry, searchSharedUi, readSharedUiAsset, reuseSharedUi, withdrawUiEntry, revokeUiAssetRights, deleteUiEntry, exportPrivateUi, UI_SHARE_NOTICE_VERSION } from "../src/lib/ui-library/service.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const owner = "fixture-owner";
const context = { game: "Private fixture", gameplay: "Private mechanics", audience: "Private research", artDirection: "Paper" };
const dim = { xScale: 0, xOffset: 0, yScale: 0, yOffset: 0 };
const layout = { version: 1, name: "Seed tray", nodes: [{ id: "tray", parentId: null, className: "ImageLabel", imageKey: "tray", name: "Tray", position: dim, size: { ...dim, xOffset: 100, yOffset: 80 }, anchorPoint: { x: 0, y: 0 }, backgroundColor: [0, 0, 0], backgroundTransparency: 1, zIndex: 1 }] };
const data = (assetId) => ({ title: "Seed tray", description: "A small planting panel", tags: ["mobile", "garden"], layout, assets: { tray: assetId } });
const consent = (entry, extra = {}) => ({ ownerId: owner, entryId: entry.id, revision: entry.revision, attribution: "Fixture creator", license: "CC-BY-4.0", noticeVersion: UI_SHARE_NOTICE_VERSION, confirmed: true, ...extra });
const fails = (promise, code) => assert.rejects(promise, (error) => error.code === code);

async function setup(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const project = await createCreativeProject(db, { ownerId: owner, name: "Private project", context });
  const assetId = await addCreativeReference(db, { ownerId: owner, projectId: project.id, bytes: png, metadata: { label: "Private image", rights: "owned", rightsNote: "PRIVATE contract evidence", performance: { metric: "click_through_rate", impressions: 100, outcomes: 7, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", source: "PRIVATE report", cohort: "PRIVATE cohort" } } });
  const entry = await createUiEntry(db, owner, project.id, data(assetId));
  const grant = (id = assetId) => declareUiAssetRights(db, { ownerId: owner, projectId: project.id, assetId: id, license: "CC-BY-4.0", attribution: "Asset creator", evidence: "PRIVATE signed sharing permission", confirmed: true });
  return { db, project, assetId, entry, grant };
}

test("drafts stay private; sharing needs separate rights and exact versioned consent", async (t) => {
  const { db, entry, grant } = await setup(t);
  assert.deepEqual(await searchSharedUi(db), []);
  await fails(shareUiEntry(db, consent(entry)), "rights_required");
  await grant();
  for (const bad of [{ confirmed: false }, { noticeVersion: "old" }, { license: "noncommercial" }]) await assert.rejects(shareUiEntry(db, consent(entry, bad)));
  assert.deepEqual(await searchSharedUi(db), []);
  const shared = await shareUiEntry(db, consent(entry));
  assert.equal(shared.revision, 2);
  assert.equal((await searchSharedUi(db, { query: "seed", tags: ["mobile"] })).length, 1);
  assert.equal((await searchSharedUi(db, { query: "%" })).length, 0);
  assert.equal((await searchSharedUi(db, { query: "' OR true --" })).length, 0);
  assert.equal((await searchSharedUi(db, { tags: ["unmatched"] })).length, 0);
  await assert.rejects(searchSharedUi(db, { limit: 1000 }));
});

test("shared search, images and reused projects never leak private metadata", async (t) => {
  const { db, entry, project, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  const search = await searchSharedUi(db);
  assert.deepEqual(Object.keys(search[0]).sort(), ["id", "revision", "title", "description", "tags", "license", "licenseUrl", "attribution", "credits", "assetKeys"].sort());
  assert.ok(!JSON.stringify(search).includes(owner));
  assert.ok(!JSON.stringify(search).includes(project.id));
  const image = await readSharedUiAsset(db, entry.id, "tray");
  assert.deepEqual(Buffer.from(image.bytes), png);
  assert.ok(!JSON.stringify(image).includes("PRIVATE"));
  const target = await createCreativeProject(db, { ownerId: "recipient", name: "Recipient", context });
  const copy = await reuseSharedUi(db, "recipient", target.id, entry.id);
  const copiedAsset = await readCreativeAsset(db, "recipient", target.id, copy.assets.tray);
  assert.equal(copiedAsset.metadata.libraryEntryId, entry.id);
  assert.equal(copiedAsset.metadata.performance, undefined);
  assert.ok(!JSON.stringify(copy).includes("PRIVATE"));
  const exported = await exportPrivateUi(db, "recipient", copy.entryId, { tray: 123 });
  assert.ok(exported.source.includes("Attribution: Fixture creator; Asset creator"));
  assert.equal(exported.implemented, false);
});

test("ownership and project boundaries apply to drafts, rights, withdrawal and export", async (t) => {
  const { db, project, assetId, entry } = await setup(t);
  await fails(readPrivateUiEntry(db, "stranger", entry.id), "not_found");
  await fails(shareUiEntry(db, consent(entry, { ownerId: "stranger" })), "not_found");
  await fails(withdrawUiEntry(db, "stranger", entry.id), "not_found");
  await fails(deleteUiEntry(db, "stranger", entry.id), "not_found");
  await fails(exportPrivateUi(db, "stranger", entry.id, { tray: 123 }), "not_found");
  await assert.rejects(declareUiAssetRights(db, { ownerId: "stranger", projectId: project.id, assetId, license: "CC-BY-4.0", attribution: "Not owner", evidence: "Claim", confirmed: true }));
  const other = await createCreativeProject(db, { ownerId: owner, name: "Other", context });
  await assert.rejects(createUiEntry(db, owner, other.id, data(assetId)));
  await fails(readSharedUiAsset(db, entry.id, "tray"), "not_found");
});

test("withdrawal stops new reads/copies and stale consent cannot republish", async (t) => {
  const { db, entry, project, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  await withdrawUiEntry(db, owner, entry.id);
  await withdrawUiEntry(db, owner, entry.id);
  assert.deepEqual(await searchSharedUi(db), []);
  await fails(readSharedUiAsset(db, entry.id, "tray"), "not_found");
  await fails(reuseSharedUi(db, owner, project.id, entry.id), "not_found");
  await fails(shareUiEntry(db, consent(entry)), "conflict");
  const current = await readPrivateUiEntry(db, owner, entry.id);
  assert.equal(current.state, "withdrawn");
  await shareUiEntry(db, consent(current));
  assert.equal((await searchSharedUi(db)).length, 1);
});

test("withdrawing a draft invalidates a share confirmation already being prepared", async (t) => {
  const { db, entry, grant } = await setup(t);
  await grant();
  await withdrawUiEntry(db, owner, entry.id);
  await fails(shareUiEntry(db, consent(entry)), "conflict");
  assert.deepEqual(await searchSharedUi(db), []);
});

test("withdrawal cascades through reuse lineage while previous private copies remain usable", async (t) => {
  const { db, entry, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  const target = await createCreativeProject(db, { ownerId: "recipient", name: "Recipient", context });
  const copy = await reuseSharedUi(db, "recipient", target.id, entry.id);
  await shareUiEntry(db, consent({ id: copy.entryId, revision: 1 }, { ownerId: "recipient", attribution: "Recipient" }));
  assert.equal((await searchSharedUi(db)).length, 2);
  const result = await withdrawUiEntry(db, owner, entry.id);
  assert.equal(result.withdrawn.length, 2);
  assert.deepEqual(await searchSharedUi(db), []);
  const draft = await readPrivateUiEntry(db, "recipient", copy.entryId);
  await fails(shareUiEntry(db, consent(draft, { ownerId: "recipient" })), "not_found");
  assert.ok((await exportPrivateUi(db, "recipient", copy.entryId, { tray: 123 })).source.includes("rbxassetid://123"));
});

test("layout-only reuse still preserves attribution and withdrawal dependencies", async (t) => {
  const { db, project } = await setup(t);
  const plain = { ...layout, nodes: [{ ...layout.nodes[0], className: "Frame" }] };
  delete plain.nodes[0].imageKey;
  const entry = await createUiEntry(db, owner, project.id, { ...data("unused"), layout: plain, assets: {} });
  await shareUiEntry(db, consent(entry));
  const target = await createCreativeProject(db, { ownerId: "recipient", name: "Recipient", context });
  const copy = await reuseSharedUi(db, "recipient", target.id, entry.id);
  await shareUiEntry(db, consent({ id: copy.entryId, revision: 1 }, { ownerId: "recipient" }));
  await withdrawUiEntry(db, owner, entry.id);
  assert.deepEqual(await searchSharedUi(db), []);
  assert.ok((await exportPrivateUi(db, "recipient", copy.entryId, {})).source.includes("Fixture creator"));
});

test("adapting reused UI preserves its licence and lineage and invalidates old confirmations", async (t) => {
  const { db, entry, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  const target = await createCreativeProject(db, { ownerId: "recipient", name: "Recipient", context });
  const copy = await reuseSharedUi(db, "recipient", target.id, entry.id);
  const adapted = { ...data(copy.assets.tray), title: "Custom tray", layout: { ...layout, name: "Custom" } };
  const draft = await updateUiEntry(db, "recipient", copy.entryId, 1, adapted);
  assert.equal(draft.revision, 2);
  assert.deepEqual(draft.source_entry_ids, [entry.id]);
  assert.equal(draft.license, "CC-BY-4.0");
  await fails(shareUiEntry(db, consent({ id: copy.entryId, revision: 1 }, { ownerId: "recipient" })), "conflict");
  await shareUiEntry(db, consent(draft, { ownerId: "recipient" }));
  await fails(updateUiEntry(db, "recipient", copy.entryId, 3, adapted), "conflict");
  await withdrawUiEntry(db, owner, entry.id);
  assert.deepEqual(await searchSharedUi(db), []);
});

test("rights revocation removes all dependent listings and requires fresh consent", async (t) => {
  const { db, project, assetId, entry, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  await revokeUiAssetRights(db, owner, project.id, assetId);
  assert.deepEqual(await searchSharedUi(db), []);
  const current = await readPrivateUiEntry(db, owner, entry.id);
  await fails(shareUiEntry(db, consent(current)), "rights_required");
  await grant();
  assert.deepEqual(await searchSharedUi(db), []);
  await shareUiEntry(db, consent(current));
  assert.equal((await searchSharedUi(db)).length, 1);
});

test("deleting a listing scrubs its content, is repeatable, and keeps private project assets separate", async (t) => {
  const { db, project, assetId, entry, grant } = await setup(t);
  await grant();
  await shareUiEntry(db, consent(entry));
  await deleteUiEntry(db, owner, entry.id);
  await deleteUiEntry(db, owner, entry.id);
  await fails(readPrivateUiEntry(db, owner, entry.id), "not_found");
  assert.deepEqual(await searchSharedUi(db), []);
  const row = (await db.query("SELECT * FROM ui_library_entries WHERE id=$1", [entry.id])).rows[0];
  assert.equal(row.title, ""); assert.equal(row.layout, null); assert.deepEqual(row.assets, {}); assert.deepEqual(row.credits, []);
  assert.deepEqual(Buffer.from((await readCreativeAsset(db, owner, project.id, assetId)).bytes), png);
});

test("generated assets require redistribution rights across all source references", async (t) => {
  const { db, project, assetId, grant } = await setup(t);
  const flowId = randomUUID(), jobId = randomUUID();
  await db.query("INSERT INTO creative_workflows(id,owner_id,project_id,kind,brief,credit_budget) VALUES($1,$2,$3,'ui','{}',10)", [flowId, owner, project.id]);
  // Synthetic provider receipt in isolated fixture storage, never a paid call.
  const generatedId = await insertAsset(db, { ownerId: owner, projectId: project.id, bytes: png, kind: "generated", metadata: { mode: "paid" } });
  await db.query("INSERT INTO creative_jobs(id,owner_id,project_id,workflow_id,concept_key,stage,status,provider_id,provider_model,provider_mode,quoted_credits,request,output_asset_id) VALUES($1,$2,$3,$4,'a','asset','succeeded','fixture','fixture','paid',1,$5,$6)", [jobId, owner, project.id, flowId, JSON.stringify({ referenceIds: [assetId] }), generatedId]);
  const derived = await createUiEntry(db, owner, project.id, data(generatedId));
  await grant(generatedId);
  await fails(shareUiEntry(db, consent(derived)), "rights_required");
  await grant(assetId);
  await shareUiEntry(db, consent(derived));
  await revokeUiAssetRights(db, owner, project.id, assetId);
  assert.deepEqual(await searchSharedUi(db), []);
});

test("test-generated and untraceable generated assets cannot enter the shared catalogue", async (t) => {
  const { db, project, grant } = await setup(t);
  for (const metadata of [{ mode: "test" }, { mode: "paid" }]) {
    const id = await insertAsset(db, { ownerId: owner, projectId: project.id, kind: "generated", bytes: png, metadata });
    await grant(id);
    const entry = await createUiEntry(db, owner, project.id, data(id));
    await fails(shareUiEntry(db, consent(entry)), "rights_required");
  }
});
