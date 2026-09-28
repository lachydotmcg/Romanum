import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { EXPORT_SECTIONS, ExportError, readExportImage, readExportPage } from "../src/lib/accounts/data-export.ts";

// A private, owner-scoped data export. These tests build the real schema with
// real rows for two owners (plus a third with nothing), including the private
// stores the export must never leak: sealed game keys, session hashes and the
// internal operator, evidence and claim identities.

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

async function account(db, robloxUserId) {
  const id = randomUUID();
  const ownerId = `account:${id}`;
  await db.query("INSERT INTO accounts(id, roblox_user_id, owner_id, username, display_name) VALUES ($1,$2,$3,'user','User')", [id, robloxUserId, ownerId]);
  return { id, ownerId };
}

async function collect(db, acct, section) {
  const records = [];
  let cursor = null;
  for (;;) {
    const page = await readExportPage(db, acct, section, cursor);
    assert.equal(page.section, section);
    assert.ok(page.records.length <= 100, `${section} page is bounded`);
    records.push(...page.records);
    if (!page.nextCursor) return records;
    assert.notEqual(page.nextCursor, cursor, "a cursor must advance");
    cursor = page.nextCursor;
    assert.ok(records.length <= 100000, "pagination must terminate");
  }
}

const pattern = (length, step = 1) => Uint8Array.from({ length }, (_, i) => (i * step) % 251);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Sentinels that must never appear anywhere in any exported section.
const SECRETS = {
  sessionHash: "f0e1d2c3".repeat(8),
  keyCiphertext: "PRIVATE-KEY-CIPHERTEXT-0001",
  operatorId: "OPERATOR-IDENTITY-SENTINEL",
  evidenceId: "EVIDENCE-IDENTITY-SENTINEL",
};

/**
 * Seeds one fully-populated owner (A) and a second owner (B) with their own
 * private rows, so every section is exercised and owner scoping is provable.
 */
async function seed(db) {
  const a = await account(db, 111);
  const b = await account(db, 222);
  const c = await account(db, 333);

  // --- Credits: balance, an operation, an immutable ledger entry.
  await db.query("INSERT INTO credits_accounts(owner_id, balance, reserved) VALUES ($1, 250, 0)", [a.ownerId]);
  await db.query("INSERT INTO credits_operations(operation_id, owner_id, kind, status, amount) VALUES ($1,$2,'grant','granted',250)", [randomUUID(), a.ownerId]);
  await db.query("INSERT INTO credits_ledger(owner_id, entry_type, status, operation_id, amount, balance_change, reserved_change, balance_after, reserved_after) VALUES ($1,'grant','granted',$2,250,250,0,250,0)", [a.ownerId, `grant:${randomUUID()}`]);
  await db.query("INSERT INTO credits_accounts(owner_id, balance, reserved) VALUES ($1, 7, 0)", [b.ownerId]);

  // --- Usage: a charge whose cost exceeds Number.MAX_SAFE_INTEGER stays exact.
  await db.query("INSERT INTO usage_charges(id, owner_id, feature, calls, cost_nano_usd, price_nano_usd, credits_charged) VALUES ($1,$2,'ask','[]',9007199254740993,9007199254740993,3)", [randomUUID(), a.ownerId]);
  await db.query("INSERT INTO usage_carry(owner_id, carry_nano_usd) VALUES ($1, 4999999)", [a.ownerId]);
  const holdId = randomUUID();
  await db.query("INSERT INTO usage_holds(id, owner_id, feature, operation_id, status, max_price_nano_usd, reserved_credits) VALUES ($1,$2,'ask',$3,'reserved',5000000,2)", [holdId, a.ownerId, `model-call:${holdId}`]);

  // --- Chats: one chat with 250 messages and one image attachment.
  const chatImage = pattern(600000, 7);
  const chatId = randomUUID();
  await db.query("INSERT INTO chats(id, owner_id, title, history) VALUES ($1,$2,'Owner A chat',$3::jsonb)", [chatId, a.ownerId, JSON.stringify([{ role: "user", content: "hello" }])]);
  await db.query("INSERT INTO chat_messages(id, chat_id, role, content) SELECT gen_random_uuid(), $1, 'user', 'm' || g FROM generate_series(1,250) g", [chatId]);
  const messageId = (await db.query("SELECT id FROM chat_messages WHERE chat_id=$1 ORDER BY seq LIMIT 1", [chatId])).rows[0].id;
  const attachmentId = randomUUID();
  await db.query("INSERT INTO chat_attachments(id, message_id, owner_id, position, name, mime_type, bytes) VALUES ($1,$2,$3,0,'ref.webp','image/webp',$4)", [attachmentId, messageId, a.ownerId, Buffer.from(chatImage)]);
  const otherChatId = randomUUID();
  await db.query("INSERT INTO chats(id, owner_id, title) VALUES ($1,$2,'Owner B chat')", [otherChatId, b.ownerId]);
  await db.query("INSERT INTO chat_messages(id, chat_id, role, content) SELECT gen_random_uuid(), $1, 'user', 'b' || g FROM generate_series(1,6) g", [otherChatId]);

  // --- Creative: a project, a generated asset, a saved plan, a job.
  const creativeImage = pattern(700001, 13);
  const projectId = randomUUID();
  await db.query("INSERT INTO creative_projects(id, owner_id, name, context) VALUES ($1,$2,'Owner A project',$3::jsonb)", [projectId, a.ownerId, JSON.stringify({ game: "Fixture", gameplay: "Plant", audience: "Mixed", artDirection: "Paper" })]);
  const assetId = randomUUID();
  await db.query("INSERT INTO creative_assets(id, owner_id, project_id, kind, bytes, mime_type, width, height, sha256, metadata) VALUES ($1,$2,$3,'generated',$4,'image/png',64,64,$5,$6::jsonb)", [assetId, a.ownerId, projectId, Buffer.from(creativeImage), sha256(creativeImage), JSON.stringify({ jobId: "j" })]);
  const workflowId = randomUUID();
  await db.query("INSERT INTO creative_workflows(id, owner_id, project_id, kind, brief, credit_budget, plan_title, project_revision, project_context, source_chat_id, source_call_id, source_input_hash) VALUES ($1,$2,$3,'thumbnail',$4::jsonb,1,'Saved plan',1,$5::jsonb,$6,'internal-call-id','deadbeef')", [workflowId, a.ownerId, projectId, JSON.stringify({ goal: "Plant", truthfulContent: "Planting", visualDirection: "Paper" }), JSON.stringify({ game: "Fixture" }), chatId]);
  const jobId = randomUUID();
  await db.query("INSERT INTO creative_jobs(id, owner_id, project_id, workflow_id, concept_key, stage, status, provider_id, provider_model, provider_mode, quoted_credits, request, provider_request_id) VALUES ($1,$2,$3,$4,'seed','concept','failed','fixture','fixture','test',1,'{}'::jsonb,'PROVIDER-REQUEST-SENTINEL')", [jobId, a.ownerId, projectId, workflowId]);
  const reviewClaimId = randomUUID();
  await db.query("INSERT INTO creative_reviews(id, owner_id, project_id, workflow_id, job_id, asset_id, reviewer_id, reviewer_model, reviewer_mode, asset_sha256, status, claim_id, approved, reason, finished_at) VALUES ($1,$2,$3,$4,$5,$6,'reviewer','reviewer-model','test',$7,'rejected',$8,false,'Too dark',now())", [randomUUID(), a.ownerId, projectId, workflowId, jobId, assetId, sha256(creativeImage), reviewClaimId]);
  const reconciliationId = randomUUID();
  await db.query("INSERT INTO creative_reconciliations(id, job_id, owner_id, project_id, operator_id, evidence_id, outcome, actual_credits, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,'not_charged',0,$7)", [reconciliationId, jobId, a.ownerId, projectId, SECRETS.operatorId, SECRETS.evidenceId, sha256("evidence")]);

  // --- Agent harness: a run (with a claim id) and an action (with a digest).
  const runId = randomUUID();
  const runClaimId = randomUUID();
  await db.query("INSERT INTO agent_runs(id, owner_id, project_id, objective, context, allowed_tools, max_steps, status, claim_id, claimed_at) VALUES ($1,$2,$3,'Paint it','{}'::jsonb,'[]'::jsonb,5,'ready',$4,now())", [runId, a.ownerId, projectId, runClaimId]);
  await db.query("INSERT INTO agent_actions(id, run_id, sequence, tool_name, tool_version, tool_scope, effect, input, reason, digest, status) VALUES ($1,$2,1,'read_project','1','project','read','{}'::jsonb,'Look','deadbeefdeadbeef','succeeded')", [randomUUID(), runId]);

  // --- UI library: rights, two entries, an event, a source and a dependency.
  await db.query("INSERT INTO ui_asset_rights(asset_id, owner_id, project_id, status, license, attribution, evidence_private) VALUES ($1,$2,$3,'granted','CC-BY-4.0','By User',$4)", [assetId, a.ownerId, projectId, "I created these assets myself."]);
  const entryOne = randomUUID();
  const entryTwo = randomUUID();
  await db.query("INSERT INTO ui_library_entries(id, owner_id, project_id, state, title, description, tags, assets) VALUES ($1,$2,$3,'draft','Draft one','A draft',ARRAY['a','b'],'[]'::jsonb)", [entryOne, a.ownerId, projectId]);
  await db.query("INSERT INTO ui_library_entries(id, owner_id, project_id, state, title, description, tags, assets) VALUES ($1,$2,$3,'draft','Draft two','Another draft',ARRAY['c'],'[]'::jsonb)", [entryTwo, a.ownerId, projectId]);
  await db.query("INSERT INTO ui_library_events(entry_id, owner_id, action, revision) VALUES ($1,$2,'shared',1)", [entryOne, a.ownerId]);
  await db.query("INSERT INTO ui_library_sources(entry_id, asset_id) VALUES ($1,$2)", [entryOne, assetId]);
  await db.query("INSERT INTO ui_library_dependencies(entry_id, source_entry_id) VALUES ($1,$2)", [entryOne, entryTwo]);

  // --- Linked games: a game, its sealed key, metrics and consent history.
  const gameId = randomUUID();
  const universeId = 3828411582;
  await db.query("INSERT INTO linked_games(id, account_id, universe_id, collect, share, shared_since, consent_version, status) VALUES ($1,$2,$3,true,true,now(),2,'active')", [gameId, a.id, universeId]);
  await db.query("INSERT INTO linked_game_keys(game_id, key_version, iv, ciphertext, tag, hint) VALUES ($1,1,$2,$3,$4,'WXYZ')", [gameId, randomBytes(12), Buffer.from(SECRETS.keyCiphertext), randomBytes(16)]);
  await db.query("INSERT INTO linked_game_metrics(game_id, metric, day, value, status) VALUES ($1,'DailyActiveUsers','2026-09-01',1234.5,'Projected')", [gameId]);
  await db.query("INSERT INTO linked_game_consents(account_id, universe_id, setting, enabled, notice) VALUES ($1,$2,'collect',true,'2026-09-27')", [a.id, universeId]);
  const otherGameId = randomUUID();
  await db.query("INSERT INTO linked_games(id, account_id, universe_id) VALUES ($1,$2,999)", [otherGameId, b.id]);
  await db.query("INSERT INTO linked_game_metrics(game_id, metric, day, value) VALUES ($1,'DailyActiveUsers','2026-09-01',77)", [otherGameId]);

  // --- A live session for owner A: its hash must never be exported.
  await db.query("INSERT INTO account_sessions(token_hash, account_id, expires_at) VALUES ($1,$2,now() + interval '1 day')", [SECRETS.sessionHash, a.id]);

  return { a, b, c, chatId, attachmentId, chatImage, projectId, assetId, creativeImage, workflowId, jobId, gameId, runClaimId, reviewClaimId };
}

test("the allowlist names the account-data sections and omits secret stores", () => {
  const expected = [
    "profile", "credits_account", "credits_operations", "credits_ledger",
    "usage_charges", "usage_carry", "usage_holds", "chats", "chat_messages",
    "chat_attachments", "creative_projects", "creative_assets", "creative_workflows",
    "creative_jobs", "creative_reviews", "creative_reconciliations", "agent_runs",
    "agent_actions", "ui_asset_rights", "ui_library_entries", "ui_library_events",
    "ui_library_sources", "ui_library_dependencies", "linked_games",
    "linked_game_metrics", "linked_game_consents",
  ];
  for (const section of expected) assert.ok(EXPORT_SECTIONS.includes(section), section);
  assert.equal(new Set(EXPORT_SECTIONS).size, EXPORT_SECTIONS.length, "sections are unique");
  for (const secret of ["sessions", "account_sessions", "linked_game_keys"]) assert.ok(!EXPORT_SECTIONS.includes(secret), secret);
  assert.ok(Object.isFrozen(EXPORT_SECTIONS) || Array.isArray(EXPORT_SECTIONS));
});

test("keyset pagination returns every owner row once, in ascending key order, across several pages", async (t) => {
  const db = await database(t);
  const { a, b } = await seed(db);

  const pages = [];
  const seen = [];
  let cursor = null;
  do {
    const page = await readExportPage(db, a, "chat_messages", cursor);
    pages.push(page.records.length);
    seen.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(pages, [100, 100, 50], "250 messages page as 100 + 100 + 50");
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen.map((record) => record.id)).size, 250, "no row is repeated");
  const expected = (await db.query('SELECT m.id FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.owner_id=$1 ORDER BY (m.id::text) COLLATE "C"', [a.ownerId])).rows.map((row) => row.id);
  assert.deepEqual(seen.map((record) => record.id), expected, "order matches the keyset order");
  const ownerAChats = new Set((await db.query("SELECT id FROM chats WHERE owner_id=$1", [a.ownerId])).rows.map((row) => row.id));
  assert.ok(seen.every((record) => ownerAChats.has(record.chat_id)), "every message belongs to an owner-A chat");
  assert.deepEqual(await collect(db, b, "chat_messages"), await collect(db, b, "chat_messages"), "owner B pages are stable");
  assert.equal((await collect(db, b, "chat_messages")).length, 6, "owner B sees only its own messages");
});

test("unknown sections, forged cursors, injection and owner mismatch are refused", async (t) => {
  const db = await database(t);
  const { a, b } = await seed(db);
  const asInvalid = async (promise) => {
    const error = await promise.then(() => null, (thrown) => thrown);
    assert.ok(error instanceof ExportError, "expected an ExportError");
    assert.equal(error.code, "invalid");
    return error;
  };

  for (const section of ["sessions", "account_sessions", "linked_game_keys", "chats; DROP TABLE accounts", "Chats", "", null, 42]) {
    await asInvalid(readExportPage(db, a, section));
  }
  // The allowlisted tables still exist after an injection attempt.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n, 3);

  const good = (await readExportPage(db, a, "chat_messages")).nextCursor;
  assert.ok(good);
  await asInvalid(readExportPage(db, a, "chat_messages", "' OR 1=1 --"));
  await asInvalid(readExportPage(db, a, "chat_messages", "not base64!!"));
  await asInvalid(readExportPage(db, a, "chat_messages", Buffer.from(JSON.stringify(["chats", "x"])).toString("base64url")));
  await asInvalid(readExportPage(db, a, "chat_messages", Buffer.from(JSON.stringify(["chat_messages"])).toString("base64url")));
  await asInvalid(readExportPage(db, a, "chat_messages", "A".repeat(2001)));

  await assert.rejects(readExportPage(db, { id: a.id, ownerId: b.ownerId }, "profile"), (error) => error instanceof ExportError && error.code === "not_found");
  await assert.rejects(readExportPage(db, { id: randomUUID(), ownerId: a.ownerId }, "profile"), (error) => error.code === "not_found");
  await asInvalid(readExportPage(db, { id: "not-a-uuid", ownerId: a.ownerId }, "profile"));
});

test("every section exports only this owner's rows and only allowlisted fields", async (t) => {
  const db = await database(t);
  const fixture = await seed(db);
  const { a, b } = fixture;

  const exported = {};
  for (const section of EXPORT_SECTIONS) exported[section] = await collect(db, a, section);

  // Profile: the account row itself, with the Roblox id as a string.
  assert.equal(exported.profile.length, 1);
  assert.equal(exported.profile[0].id, a.id);
  assert.equal(exported.profile[0].owner_id, a.ownerId);
  assert.equal(typeof exported.profile[0].roblox_user_id, "string");
  assert.match(exported.profile[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "timestamps are ISO strings");
  assert.ok(!("token_hash" in exported.profile[0]));

  // Credits: bigint values stay strings so nothing is rounded.
  assert.equal(exported.credits_account[0].balance, "250");
  assert.equal(exported.usage_charges[0].cost_nano_usd, "9007199254740993");
  assert.equal(typeof exported.usage_charges[0].cost_nano_usd, "string");
  assert.equal(exported.credits_ledger[0].amount, "250");
  assert.equal(exported.usage_carry[0].carry_nano_usd, "4999999");
  assert.ok(!("call_fingerprint" in exported.usage_holds[0]), "holds omit the internal call fingerprint");

  // Attachments and assets expose metadata and byte length, never bytes.
  assert.equal(exported.chat_attachments.length, 1);
  assert.equal(exported.chat_attachments[0].byte_length, fixture.chatImage.length);
  assert.equal(exported.chat_attachments[0].mime_type, "image/webp");
  assert.equal(exported.chat_attachments[0].name, "ref.webp");
  assert.ok(!("bytes" in exported.chat_attachments[0]));
  assert.equal(exported.creative_assets[0].byte_length, fixture.creativeImage.length);
  assert.equal(exported.creative_assets[0].sha256, sha256(fixture.creativeImage));
  assert.ok(!("bytes" in exported.creative_assets[0]));

  // Creative lineage joins forward: plan, job, review and reconciliation.
  assert.equal(exported.creative_projects[0].id, fixture.projectId);
  assert.equal(exported.creative_workflows[0].plan_title, "Saved plan");
  assert.equal(exported.creative_workflows[0].source_chat_id, fixture.chatId);
  assert.equal(exported.creative_jobs[0].output_asset_id, null);
  assert.equal(exported.creative_reviews[0].status, "rejected");
  assert.equal(exported.creative_reconciliations[0].outcome, "not_charged");

  // The UI relations and the linked-game rows resolve to this owner.
  assert.equal(exported.ui_library_entries.length, 2);
  assert.equal(exported.ui_library_sources.length, 1);
  assert.equal(exported.ui_library_dependencies.length, 1);
  assert.equal(exported.linked_games[0].id, fixture.gameId);
  assert.equal(exported.linked_games[0].universe_id, "3828411582");
  assert.equal(exported.linked_game_metrics[0].metric, "DailyActiveUsers");
  assert.equal(exported.linked_game_consents.length, 1);

  // Internal identities and secret material are never present.
  const blob = JSON.stringify(exported);
  for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!blob.includes(secret), `${name} must not be exported`);
  assert.ok(!blob.includes(fixture.runClaimId), "the agent run claim id must not be exported");
  assert.ok(!blob.includes(fixture.reviewClaimId), "the review claim id must not be exported");
  assert.ok(!blob.includes("PROVIDER-REQUEST-SENTINEL"));
  assert.ok(!blob.includes("internal-call-id"));
  assert.ok(!blob.includes("deadbeef"));
  for (const record of exported.agent_runs) assert.ok(!("claim_id" in record) && !("claimed_at" in record));
  for (const record of exported.creative_reviews) assert.ok(!("claim_id" in record));
  for (const record of exported.creative_reconciliations) assert.ok(!("operator_id" in record) && !("evidence_id" in record) && !("fingerprint" in record));
  for (const record of exported.creative_jobs) assert.ok(!("provider_request_id" in record));
  for (const record of exported.creative_workflows) assert.ok(!("source_call_id" in record) && !("source_input_hash" in record) && !("source_chat_key" in record));
  assert.equal(exported.ui_asset_rights[0].evidence_private, "I created these assets myself.");

  // Nothing belongs to the second owner.
  for (const section of EXPORT_SECTIONS) {
    const forbidden = await collect(db, b, section);
    const ids = new Set(forbidden.map((record) => JSON.stringify(record)));
    for (const record of exported[section]) assert.ok(!ids.has(JSON.stringify(record)), `${section} leaked another owner's row`);
  }
});

test("a column added later is not exported because every column is named", async (t) => {
  const db = await database(t);
  const { a } = await seed(db);
  await db.exec("ALTER TABLE accounts ADD COLUMN private_flag text; ALTER TABLE chats ADD COLUMN private_note text;");
  await db.query("UPDATE accounts SET private_flag='LEAK-ACCOUNT-FLAG' WHERE id=$1", [a.id]);
  await db.query("UPDATE chats SET private_note='LEAK-CHAT-NOTE' WHERE owner_id=$1", [a.ownerId]);

  const profile = await collect(db, a, "profile");
  const chats = await collect(db, a, "chats");
  assert.ok(!("private_flag" in profile[0]));
  assert.ok(!("private_note" in chats[0]));
  assert.ok(!JSON.stringify([profile, chats]).includes("LEAK-"));
});

test("a new tables/columns never widen the allowlist: unknown names and non-existent tables are rejected", async (t) => {
  const db = await database(t);
  const { a } = await seed(db);
  await db.exec("CREATE TABLE exported_secret_store(id uuid PRIMARY KEY, owner_id text, secret text);");
  await assert.rejects(readExportPage(db, a, "exported_secret_store"), (error) => error.code === "invalid");
  await assert.rejects(readExportPage(db, a, "information_schema.tables"), (error) => error.code === "invalid");
  for (const inherited of ["constructor", "__proto__", "toString"]) {
    await assert.rejects(readExportPage(db, a, inherited), (error) => error.code === "invalid");
  }
});

test("image reads are byte-exact, chunked and owner-scoped, and bad ranges are refused", async (t) => {
  const db = await database(t);
  const { a, b, attachmentId, chatImage, assetId, creativeImage } = await seed(db);

  const assemble = async (acct, kind, id) => {
    const pieces = [];
    let offset = 0;
    for (;;) {
      const slice = await readExportImage(db, acct, kind, id, offset);
      assert.ok(slice, "an owned image is readable");
      assert.ok(slice.bytes.length <= 512 * 1024, "each read is bounded");
      assert.equal(slice.totalBytes, kind === "chat" ? chatImage.length : creativeImage.length);
      pieces.push(slice.bytes);
      if (slice.nextOffset === null) break;
      assert.equal(slice.nextOffset, offset + slice.bytes.length);
      offset = slice.nextOffset;
    }
    return { pieces, offset };
  };

  const chat = await assemble(a, "chat", attachmentId);
  assert.equal(chat.pieces[0].length, 512 * 1024, "the first chat slice fills the chunk");
  assert.deepEqual(Buffer.concat(chat.pieces.map(Buffer.from)), Buffer.from(chatImage), "chat image reassembles byte-for-byte");

  const creative = await assemble(a, "creative", assetId);
  assert.deepEqual(Buffer.concat(creative.pieces.map(Buffer.from)), Buffer.from(creativeImage), "creative image reassembles byte-for-byte");

  const first = await readExportImage(db, a, "chat", attachmentId, 0);
  assert.equal(first.mimeType, "image/webp");
  assert.equal(first.totalBytes, chatImage.length);

  // Ownership and existence: another owner and a missing id both read as null.
  assert.equal(await readExportImage(db, b, "chat", attachmentId, 0), null);
  assert.equal(await readExportImage(db, b, "creative", assetId, 0), null);
  assert.equal(await readExportImage(db, a, "chat", randomUUID(), 0), null);
  assert.equal(await readExportImage(db, a, "creative", randomUUID(), 0), null);
  assert.equal(await readExportImage(db, a, "creative", attachmentId, 0), null, "kinds do not cross");
  assert.equal(await readExportImage(db, a, "chat", assetId, 0), null, "kinds do not cross");

  // Account mismatch and missing account are not found.
  await assert.rejects(readExportImage(db, { id: a.id, ownerId: b.ownerId }, "chat", attachmentId, 0), (error) => error.code === "not_found");
  await assert.rejects(readExportImage(db, { id: randomUUID(), ownerId: a.ownerId }, "chat", attachmentId, 0), (error) => error.code === "not_found");

  // Malformed ids and out-of-range offsets are invalid, never a silent null.
  const asInvalid = (promise) => assert.rejects(promise, (error) => error instanceof ExportError && error.code === "invalid");
  for (const bad of ["not-a-uuid", "", `${attachmentId}x`]) await asInvalid(readExportImage(db, a, "chat", bad, 0));
  for (const bad of [-1, 1.5, 10 * 1024 * 1024 + 1, Number.NaN, Number.POSITIVE_INFINITY]) await asInvalid(readExportImage(db, a, "chat", attachmentId, bad));
  await asInvalid(readExportImage(db, a, "chat", attachmentId, chatImage.length));
  await asInvalid(readExportImage(db, a, "chat", attachmentId, chatImage.length + 1));
  await asInvalid(readExportImage(db, a, "chat", attachmentId, "0"));
  await asInvalid(readExportImage(db, a, "other", attachmentId, 0));

  // The boundary offset is exactly the last chunk's start.
  const boundary = 512 * 1024;
  const last = await readExportImage(db, a, "chat", attachmentId, boundary);
  assert.equal(last.bytes.length, chatImage.length - boundary);
  assert.equal(last.nextOffset, null);
});

test("an account with no data exports empty pages and writes nothing", async (t) => {
  const db = await database(t);
  const { c } = await seed(db);
  const tables = ["credits_accounts", "credits_operations", "credits_ledger", "usage_charges", "usage_carry", "usage_holds", "chats", "chat_messages", "chat_attachments", "creative_projects", "creative_assets", "creative_workflows", "creative_jobs", "creative_reviews", "creative_reconciliations", "agent_runs", "agent_actions", "ui_asset_rights", "ui_library_entries", "ui_library_events", "ui_library_sources", "ui_library_dependencies", "linked_games", "linked_game_keys", "linked_game_metrics", "linked_game_consents", "account_sessions"];
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n])));

  const before = await counts();
  for (const section of EXPORT_SECTIONS) {
    const page = await readExportPage(db, c, section);
    if (section === "profile") {
      assert.equal(page.records.length, 1, "the empty account still exports its own profile");
      assert.equal(page.records[0].id, c.id);
    } else {
      assert.deepEqual(page.records, [], section);
    }
    assert.equal(page.nextCursor, null, section);
  }
  assert.deepEqual(await counts(), before, "reading an export never writes");
});

test("the page byte budget splits a multi-row page and every record is still delivered once", async (t) => {
  const db = await database(t);
  const { c } = await seed(db);

  // Five chats of ~220 KB each: only two fit in a 512 KiB page, so a third is
  // pushed to the next page along with a cursor.
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const id = randomUUID();
    ids.push(id);
    await db.query("INSERT INTO chats(id, owner_id, title, history) VALUES ($1,$2,$3,$4::jsonb)", [id, c.ownerId, `Big ${i}`, JSON.stringify([{ role: "user", content: "x".repeat(220000) }])]);
  }
  const pages = [];
  const seen = [];
  let cursor = null;
  do {
    const page = await readExportPage(db, c, "chats", cursor);
    pages.push(page.records.length);
    seen.push(...page.records.map((record) => record.id));
    if (page.records.length > 1) assert.ok(Buffer.byteLength(JSON.stringify(page.records), "utf8") <= 512 * 1024, "a multi-row page stays within 512 KiB");
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, [2, 2, 1], "the byte budget caps each page at two big records");
  assert.deepEqual([...seen].sort(), [...ids].sort(), "every big chat is exported once");
  assert.equal(new Set(seen).size, seen.length);
});

test("a lone record over the page budget is returned whole, but one over 3 MiB is refused", async (t) => {
  const db = await database(t);
  const { c } = await seed(db);
  const big = randomUUID();
  await db.query("INSERT INTO chats(id, owner_id, title, history) VALUES ($1,$2,'Near limit',$3::jsonb)", [big, c.ownerId, JSON.stringify([{ role: "user", content: "x".repeat(1_000_000) }])]);

  // A single allowed record larger than 512 KiB is emitted whole on its own page.
  const page = await readExportPage(db, c, "chats");
  assert.deepEqual(page.records.map((record) => record.id), [big]);
  assert.equal(page.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(page.records), "utf8") > 512 * 1024, "the lone record exceeds the page budget yet is returned");

  // A single record over 3 MiB is reported, never skipped or truncated.
  const huge = randomUUID();
  await db.query("INSERT INTO chats(id, owner_id, title, history) VALUES ($1,$2,'Huge',$3::jsonb)", [huge, c.ownerId, JSON.stringify([{ role: "user", content: "y".repeat(3_600_000) }])]);
  let cursor2 = null;
  let sawHuge = false;
  const thrown = await (async () => {
    for (;;) {
      const nextPage = await readExportPage(db, c, "chats", cursor2);
      if (nextPage.records.some((record) => record.id === huge)) sawHuge = true;
      if (!nextPage.nextCursor) return null;
      cursor2 = nextPage.nextCursor;
    }
  })().catch((error) => error);
  assert.ok(thrown instanceof ExportError, "the oversize record surfaces an error");
  assert.equal(thrown.code, "too_large");
  assert.equal(sawHuge, false, "the oversize record is never silently skipped past");
});

test("large pages are bounded before database results reach the application", async (t) => {
  const db = await database(t);
  const acct = await account(db, 8181);
  await db.query("INSERT INTO chats(id,owner_id,title,history) SELECT gen_random_uuid(),$1,'Long chat',jsonb_build_array(jsonb_build_object('content',repeat('x',200000))) FROM generate_series(1,20)", [acct.ownerId]);
  let largestResult = 0;
  const measured = { ...db, transaction: (operation) => db.transaction((sql) => operation({
    ...sql, query: async (text, values) => {
      const result = await sql.query(text, values);
      largestResult = Math.max(largestResult, Buffer.byteLength(JSON.stringify(result)));
      return result;
    },
  })) };
  assert.equal((await collect(measured, acct, "chats")).length, 20);
  assert.ok(largestResult < 512 * 1024, `database transferred ${largestResult} bytes at once`);
});
