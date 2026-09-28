import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject, updateProject } from "../src/lib/projects/store.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import { ImageInputError } from "../src/lib/chats/image-input.ts";
import {
  ReferenceError as ReferenceStoreError,
  MAX_PROJECT_REFERENCES,
  addProjectReference,
  deleteProjectReference,
  listProjectReferences,
  readProjectReference,
  referenceInputSchema,
} from "../src/lib/projects/references.ts";

// Private project references run on the fully migrated application schema in an
// isolated in-memory database. Every image, project and account below is invented
// test data: no provider, browser, cookie or real account is touched.

const OWNER = "owner:references";
const OTHER_OWNER = "owner:other";
const CONTEXT = { game: "Reference test game" };
const METADATA = { label: "Reference image", rights: "owned", rightsNote: "Original work" };
// A tiny but real PNG envelope, used only for SQL fixtures that bypass the decoder.
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const TINY_SHA = createHash("sha256").update(TINY_PNG).digest("hex");

// Real, decodable images. The decoder preserves transparency and strips metadata.
const picture = (width = 32, height = 16) => sharp({ create: { width, height, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 0.5 } } });

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

const count = async (db, table, where = "true", values = []) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n);
const rejects = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a ReferenceError"), (thrown) => thrown);
  assert.ok(error instanceof ReferenceStoreError, `expected ReferenceError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};
// Records every statement, inside and outside a transaction, for the no-bytes read test.
const withSqlLog = (db, statements) => ({
  ...db,
  query: (text, values) => { statements.push(text); return db.query(text, values); },
  transaction: (operation) => db.transaction((sql) => operation({ ...sql, query: (text, values) => { statements.push(text); return sql.query(text, values); } })),
});

// Inserts an asset the way internal creative work would: no managed source marker.
async function addInternalAsset(db, ownerId, projectId, kind, metadata = { label: "Internal", rights: "owned", rightsNote: "Fixture" }) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,$4,$5,'image/png',1,1,$6,$7)",
    [id, ownerId, projectId, kind, TINY_PNG, TINY_SHA, JSON.stringify(metadata)],
  );
  return id;
}

async function addWorkflow(db, ownerId, projectId, referenceIds = []) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO creative_workflows(id,owner_id,project_id,kind,brief,reference_ids,credit_budget) VALUES($1,$2,$3,'thumbnail',$4,$5,0)",
    [id, ownerId, projectId, JSON.stringify({ goal: "Fixture" }), JSON.stringify(referenceIds)],
  );
  return id;
}

async function addJob(db, ownerId, projectId, workflowId, { referenceIds = [], outputAssetId = null, status = "queued" } = {}) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO creative_jobs(id,owner_id,project_id,workflow_id,concept_key,stage,status,provider_id,provider_model,provider_mode,quoted_credits,request,output_asset_id) VALUES($1,$2,$3,$4,'concept','concept',$5,'fixture-provider','fixture-model','test',1,$6,$7)",
    [id, ownerId, projectId, workflowId, status, JSON.stringify({ referenceIds }), outputAssetId],
  );
  return id;
}

test("real PNG, JPEG and WebP uploads normalise to private PNGs without metadata", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Formats", context: CONTEXT });
  for (const [format, rights] of [["png", "owned"], ["jpeg", "licensed"], ["webp", "owned"]]) {
    const bytes = await picture()[format]().withExif({ IFD0: { Artist: "Private artist", ImageDescription: "Private metadata" } }).toBuffer();
    const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes, metadata: { ...METADATA, rights } });
    assert.equal(reference.rights, rights);
    const stored = await readProjectReference(db, OWNER, project.id, reference.id);
    assert.ok(stored, `${format}: the stored reference was not readable`);
    assert.equal(Buffer.from(stored.bytes).length, reference.byteLength);
    const metadata = await sharp(stored.bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 16);
    for (const key of ["exif", "xmp", "icc", "iptc"]) assert.equal(metadata[key], undefined);
    assert.ok(!Buffer.from(stored.bytes).includes(Buffer.from("Private metadata")));
  }
});

test("orientation is applied and transparency is kept while bounding the longest edge", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Normalise", context: CONTEXT });

  const alpha = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture(64, 64).png().toBuffer(), metadata: METADATA });
  const storedAlpha = await readProjectReference(db, OWNER, project.id, alpha.id);
  assert.equal((await sharp(storedAlpha.bytes).metadata()).hasAlpha, true);

  const rotated = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture(100, 50).jpeg().withMetadata({ orientation: 6 }).toBuffer(), metadata: METADATA });
  assert.equal(rotated.width, 50);
  assert.equal(rotated.height, 100);
  const orientation = await sharp((await readProjectReference(db, OWNER, project.id, rotated.id)).bytes).metadata();
  assert.equal(orientation.orientation, undefined);

  const large = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture(2400, 1200).png().toBuffer(), metadata: METADATA });
  assert.equal(large.width, 1600);
  assert.equal(large.height, 800);
});

test("malformed, unsupported, oversized and animated uploads fail closed before writing", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Reject", context: CONTEXT });
  const valid = await picture().png().toBuffer();
  const raw = Buffer.from([...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 255]).flat()]);
  const animation = await sharp(raw, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages, 2);
  const cases = [
    Buffer.alloc(0), valid.subarray(0, 24), Buffer.from([255, 216, 255, 224]),
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>"),
    Buffer.concat([valid, Buffer.alloc(5 * 1024 * 1024)]),
    await picture(8193, 1).png().toBuffer(), animation, "not bytes",
  ];
  for (const bytes of cases) {
    await assert.rejects(
      addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes, metadata: METADATA }),
      (error) => (error instanceof ReferenceStoreError && error.code === "invalid_input") || error instanceof ImageInputError,
    );
  }
  assert.equal(await count(db, "creative_assets"), 0);
});

test("reference metadata is plain and strict: performance claims and extra fields are refused", async (t) => {
  assert.equal(referenceInputSchema.safeParse(METADATA).success, true);
  const performance = { metric: "click_through_rate", impressions: 100, outcomes: 2, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", source: "Developer export", cohort: "Campaign" };
  for (const invalid of [
    { ...METADATA, performance },
    { ...METADATA, extra: true },
    { ...METADATA, ownerId: "attacker" },
    { ...METADATA, source: "attacker" },
    { ...METADATA, rights: "unknown" },
    { ...METADATA, label: "" },
    { ...METADATA, label: "l".repeat(101) },
    { ...METADATA, rightsNote: "" },
    { ...METADATA, rightsNote: "n".repeat(501) },
    { label: METADATA.label, rights: METADATA.rights },
    null, "text", 42, [],
  ]) assert.equal(referenceInputSchema.safeParse(invalid).success, false);

  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Metadata", context: CONTEXT });
  for (const metadata of [{ ...METADATA, performance }, { ...METADATA, source: "attacker" }, { ...METADATA, ctr: 0.4 }]) {
    await rejects(addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata }), "invalid_input");
  }
  assert.equal(await count(db, "creative_assets"), 0);
});

test("managed references are private; internal images are never readable or listed", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Private", context: CONTEXT });
  const otherProject = await createProject(db, { ownerId: OTHER_OWNER, name: "Other", context: CONTEXT });
  const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  const internalGenerated = await addInternalAsset(db, OWNER, project.id, "generated");
  const internalReference = await addInternalAsset(db, OWNER, project.id, "reference");

  assert.ok(await readProjectReference(db, OWNER, project.id, reference.id));
  for (const [owner, proj, id] of [
    [OTHER_OWNER, project.id, reference.id], [OWNER, otherProject.id, reference.id], [OWNER, project.id, randomUUID()],
    [OWNER, project.id, "not-a-uuid"], ["", project.id, reference.id], [OWNER, "not-a-uuid", reference.id],
    [OWNER, project.id, internalGenerated], [OWNER, project.id, internalReference],
  ]) assert.equal(await readProjectReference(db, owner, proj, id), null);

  assert.deepEqual((await listProjectReferences(db, OWNER, project.id)).map((entry) => entry.id), [reference.id]);
  await rejects(listProjectReferences(db, OTHER_OWNER, project.id), "not_found");
  await rejects(listProjectReferences(db, OWNER, otherProject.id), "not_found");
  await rejects(listProjectReferences(db, OWNER, randomUUID()), "not_found");
  await rejects(listProjectReferences(db, OWNER, "bad"), "not_found");
  await rejects(deleteProjectReference(db, OWNER, project.id, internalReference), "not_found");
  await rejects(deleteProjectReference(db, OWNER, project.id, internalGenerated), "not_found");
  await rejects(deleteProjectReference(db, OWNER, otherProject.id, reference.id), "not_found");
  await rejects(deleteProjectReference(db, OTHER_OWNER, project.id, reference.id), "not_found");
  assert.equal(await count(db, "creative_assets"), 3);
});

test("archived projects still read and clear references, but refuse new uploads", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Archive", context: CONTEXT });
  const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  await updateProject(db, { ownerId: OWNER, id: project.id, revision: 1, name: "Archive", context: CONTEXT, archived: true });

  assert.deepEqual((await listProjectReferences(db, OWNER, project.id)).map((entry) => entry.id), [reference.id]);
  assert.ok(await readProjectReference(db, OWNER, project.id, reference.id));
  await rejects(addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA }), "conflict");
  await deleteProjectReference(db, OWNER, project.id, reference.id);
  assert.equal(await readProjectReference(db, OWNER, project.id, reference.id), null);
  assert.equal(await count(db, "creative_assets"), 0);
});

test("a reference grants no sharing right and never leaks owner, bytes or metadata", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Scope", context: CONTEXT });
  const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });

  assert.deepEqual(Object.keys(reference).sort(), ["byteLength", "createdAt", "height", "id", "label", "projectId", "rights", "rightsNote", "width"].sort());
  const serialized = JSON.stringify(reference);
  assert.ok(!serialized.includes(OWNER));
  assert.ok(!serialized.includes("source"));
  assert.ok(!serialized.includes("sha256"));
  const stored = (await db.query("SELECT metadata FROM creative_assets WHERE id=$1", [reference.id])).rows[0];
  assert.deepEqual(Object.keys(stored.metadata).sort(), ["label", "rights", "rightsNote", "source"].sort());
  assert.equal(stored.metadata.source, "project-upload");
  for (const table of ["ui_asset_rights", "ui_library_entries", "ui_library_sources", "creative_jobs", "creative_workflows", "creative_reviews", "creative_reconciliations", "credits_ledger", "credits_operations", "usage_holds"]) {
    assert.equal(await count(db, table), 0, `${table} was written by an upload`);
  }
});

test("listing reads no image bytes and never uses a wildcard", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Listing", context: CONTEXT });
  await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  const statements = [];
  const listed = await listProjectReferences(withSqlLog(db, statements), OWNER, project.id);
  assert.equal(listed.length, 1);
  assert.ok(statements.some((text) => /from creative_assets/i.test(text)));
  for (const text of statements) {
    const withoutMeasurement = text.replace(/octet_length\s*\(\s*bytes\s*\)/gi, "");
    assert.ok(!/\bbytes\b/i.test(withoutMeasurement), `listing read image bytes: ${text}`);
    assert.ok(!/select\s+\*/i.test(text), `listing used a wildcard: ${text}`);
  }
});

test("the owner quota counts every stored asset across projects and cannot be bypassed", async (t) => {
  const db = await database(t);
  const first = await createProject(db, { ownerId: OWNER, name: "First", context: CONTEXT });
  const second = await createProject(db, { ownerId: OWNER, name: "Second", context: CONTEXT });
  const otherProject = await createProject(db, { ownerId: OTHER_OWNER, name: "Other", context: CONTEXT });

  // Fill the owner's quota with raw fixture bytes: 5 x 5 MiB = 25 MiB, split
  // across two projects and across asset kinds, so neither can be used to bypass it.
  const block = Buffer.alloc(5 * 1024 * 1024);
  for (let index = 0; index < 5; index++) {
    await db.query(
      "INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,$4,$5,'image/png',1,1,$6,$7)",
      [randomUUID(), OWNER, index < 3 ? first.id : second.id, index < 4 ? "generated" : "reference", block, TINY_SHA, JSON.stringify({ label: "Fixture", rights: "owned", rightsNote: "Fixture" })],
    );
  }
  const statements = [];
  await rejects(addProjectReference(withSqlLog(db, statements), { ownerId: OWNER, projectId: first.id, bytes: await picture().png().toBuffer(), metadata: METADATA }), "limit");
  assert.ok(statements.some((text) => /pg_advisory_xact_lock\(\s*hashtextextended/i.test(text)), "the upload did not take the owner advisory lock");
  await rejects(addProjectReference(db, { ownerId: OWNER, projectId: second.id, bytes: await picture().png().toBuffer(), metadata: METADATA }), "limit");

  // A different owner's quota is untouched.
  const stored = await addProjectReference(db, { ownerId: OTHER_OWNER, projectId: otherProject.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  assert.ok(stored.id);
  assert.equal(await count(db, "creative_assets", "owner_id=$1", [OWNER]), 5);
});

test("a project keeps at most 24 managed references, and deleting one frees a slot", async (t) => {
  const db = await database(t);
  const owner = "owner:counts";
  const project = await createProject(db, { ownerId: owner, name: "Counts", context: CONTEXT });
  for (let index = 0; index < MAX_PROJECT_REFERENCES; index++) {
    await db.query(
      "INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,'reference',$4,'image/png',1,1,$5,$6)",
      [randomUUID(), owner, project.id, TINY_PNG, TINY_SHA, JSON.stringify({ ...METADATA, source: "project-upload" })],
    );
  }
  assert.equal((await listProjectReferences(db, owner, project.id)).length, MAX_PROJECT_REFERENCES);
  await rejects(addProjectReference(db, { ownerId: owner, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA }), "limit");

  const [oldest] = await listProjectReferences(db, owner, project.id);
  await deleteProjectReference(db, owner, project.id, oldest.id);
  const added = await addProjectReference(db, { ownerId: owner, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  assert.ok(added.id);
  assert.equal((await listProjectReferences(db, owner, project.id)).length, MAX_PROJECT_REFERENCES);
});

test("deleting a reference removes only that row, never another owner's or a chat copy", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Delete", context: CONTEXT });
  const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  const otherProject = await createProject(db, { ownerId: OTHER_OWNER, name: "Other", context: CONTEXT });
  const otherAsset = await addInternalAsset(db, OTHER_OWNER, otherProject.id, "reference");

  const chatId = randomUUID();
  await db.query("INSERT INTO chats(id,owner_id,title,history) VALUES($1,$2,'Saved chat','[]')", [chatId, OWNER]);
  const messageId = randomUUID();
  await db.query("INSERT INTO chat_messages(id,chat_id,role,content,events) VALUES($1,$2,'user','A saved question','[]')", [messageId, chatId]);
  const attachmentId = randomUUID();
  await db.query("INSERT INTO chat_attachments(id,message_id,owner_id,position,name,mime_type,bytes) VALUES($1,$2,$3,0,'reference.png','image/png',$4)", [attachmentId, messageId, OWNER, TINY_PNG]);

  await deleteProjectReference(db, OWNER, project.id, reference.id);
  assert.equal(await readProjectReference(db, OWNER, project.id, reference.id), null);
  assert.equal(await count(db, "creative_assets", "id=$1", [reference.id]), 0);
  assert.equal(await count(db, "creative_assets", "id=$1", [otherAsset]), 1);
  assert.equal(await count(db, "chat_attachments", "id=$1", [attachmentId]), 1);
  await rejects(deleteProjectReference(db, OWNER, project.id, reference.id), "not_found");
});

test("a reference cited by saved work or a listing is refused rather than broken", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Usage", context: CONTEXT });
  const usages = {
    "workflow reference ids": async (refId) => { await addWorkflow(db, OWNER, project.id, [refId]); },
    "job request reference ids": async (refId) => { const workflow = await addWorkflow(db, OWNER, project.id); await addJob(db, OWNER, project.id, workflow, { referenceIds: [refId] }); },
    "job output asset": async (refId) => { const workflow = await addWorkflow(db, OWNER, project.id); await addJob(db, OWNER, project.id, workflow, { outputAssetId: refId, status: "succeeded" }); },
    "library entry assets": async (refId) => {
      await db.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft','Listing','Fixture',ARRAY[]::text[],NULL,$4)", [randomUUID(), OWNER, project.id, JSON.stringify({ tray: refId })]);
    },
    "library source": async (refId) => {
      const entryId = randomUUID();
      await db.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft','Listing','Fixture',ARRAY[]::text[],NULL,'{}')", [entryId, OWNER, project.id]);
      await db.query("INSERT INTO ui_library_sources(entry_id,asset_id) VALUES($1,$2)", [entryId, refId]);
    },
    "asset rights": async (refId) => {
      await db.query("INSERT INTO ui_asset_rights(asset_id,owner_id,project_id,status,license,attribution,evidence_private) VALUES($1,$2,$3,'granted','CC-BY-4.0','Fixture','private evidence')", [refId, OWNER, project.id]);
    },
    "review asset": async (refId) => {
      const workflow = await addWorkflow(db, OWNER, project.id);
      const job = await addJob(db, OWNER, project.id, workflow, { outputAssetId: refId, status: "succeeded" });
      await db.query("INSERT INTO creative_reviews(id,owner_id,project_id,workflow_id,job_id,asset_id,reviewer_id,reviewer_model,reviewer_mode,asset_sha256,status,claim_id) VALUES($1,$2,$3,$4,$5,$6,'reviewer','fixture-model','test',$7,'claimed',$8)", [randomUUID(), OWNER, project.id, workflow, job, refId, TINY_SHA, randomUUID()]);
    },
    "reconciliation output": async (refId) => {
      const workflow = await addWorkflow(db, OWNER, project.id);
      const job = await addJob(db, OWNER, project.id, workflow, { outputAssetId: refId, status: "succeeded" });
      await db.query("INSERT INTO creative_reconciliations(id,job_id,owner_id,project_id,operator_id,evidence_id,outcome,actual_credits,output_asset_id,fingerprint) VALUES($1,$2,$3,$4,'operator','evidence','recovered',1,$5,$6)", [randomUUID(), job, OWNER, project.id, refId, TINY_SHA]);
    },
  };
  for (const [name, build] of Object.entries(usages)) {
    const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
    await build(reference.id);
    await rejects(deleteProjectReference(db, OWNER, project.id, reference.id), "conflict");
    assert.equal(await count(db, "creative_assets", "id=$1", [reference.id]), 1, `${name}: the reference was deleted while in use`);
  }
});

test("account closure removes a closed owner's references and later uploads fail", async (t) => {
  const db = await database(t);
  const ownerId = `account:${randomUUID()}`;
  const accountId = randomUUID();
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,picture_url) VALUES($1,$2,$3,'refuser','Ref user',NULL)", [accountId, 990001, ownerId]);
  const project = await createProject(db, { ownerId, name: "Closing", context: CONTEXT });
  const reference = await addProjectReference(db, { ownerId, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA });
  assert.equal(await count(db, "creative_assets", "id=$1", [reference.id]), 1);

  await closeAccount(db, { id: accountId, ownerId });
  assert.equal(await count(db, "creative_assets", "owner_id=$1", [ownerId]), 0);
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [ownerId]), 0);
  assert.equal(await count(db, "account_closures", "owner_id=$1", [ownerId]), 1);
  await rejects(addProjectReference(db, { ownerId, projectId: project.id, bytes: await picture().png().toBuffer(), metadata: METADATA }), "not_found");
});

test("valid grayscale and alpha PNGs decode without relying on a malformed fixture", async t => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: OWNER, name: "Mask", context: CONTEXT });
  const png = await sharp(Buffer.alloc(16 * 16 * 2, 128), { raw: { width: 16, height: 16, channels: 2 } }).toColourspace("b-w").png().toBuffer();
  assert.equal((await sharp(png).metadata()).channels, 2);
  const reference = await addProjectReference(db, { ownerId: OWNER, projectId: project.id, bytes: png, metadata: METADATA });
  const stored = await readProjectReference(db, OWNER, project.id, reference.id);
  assert.equal((await sharp(stored.bytes).metadata()).hasAlpha, true);
});
