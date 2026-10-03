import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { AccountClosureError, closeAccount, isClosedOwner } from "../src/lib/accounts/closure.ts";
import { getBalance, grantCredits, reserveCredits, settleReservation } from "../src/lib/credits/ledger.ts";
import { reserveUsage, settleUsage } from "../src/lib/credits/usage-holds.ts";
import { LEGACY_PRICING_POLICY } from "../src/lib/credits/pricing-policy.ts";

// Account closure runs on the real application schema, migrated in full, in an
// isolated in-memory database. Every account, game, chat and image below is
// invented test data: no provider, browser, cookie or real account is touched.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
// A single model call costs $0.03: 4.95 legacy credits or 7.5 current credits.
const heavyCall = () => ({ model: "deepseek-flash", at: new Date("2026-09-23T02:00:00Z"), input: 100_000, cachedInput: 0, output: 0 });

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

const count = async (db, table, where = "true", values = []) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n);
const rows = async (db, text, values = []) => (await db.query(text, values)).rows;

const rejectsClosure = (promise, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof AccountClosureError, `expected AccountClosureError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return true;
});
// The guard triggers raise SQLSTATE 55000; a stale write must fail, not silently succeed.
const rejectsStaleWrite = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error?.code, "55000", `expected a closed-owner guard rejection, received ${error?.name}: ${error?.message}`);
  return true;
});

async function newAccount(db, robloxUserId, ownerId = `account:${randomUUID()}`) {
  const id = randomUUID();
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,picture_url) VALUES($1,$2,$3,$4,$5,NULL)", [id, robloxUserId, ownerId, `user${robloxUserId}`, `User ${robloxUserId}`]);
  return { id, ownerId, robloxUserId };
}

async function addProject(db, ownerId, name = "Private project") {
  const id = randomUUID();
  await db.query("INSERT INTO creative_projects(id,owner_id,name,context) VALUES($1,$2,$3,$4)", [id, ownerId, name, JSON.stringify({ game: name })]);
  return id;
}

async function addAsset(db, ownerId, projectId, kind = "reference") {
  const id = randomUUID();
  await db.query(
    "INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,$4,$5,'image/png',1,1,$6,$7)",
    [id, ownerId, projectId, kind, PNG, PNG_SHA, JSON.stringify({ label: "Reference", rights: "owned", rightsNote: "Own work" })],
  );
  return id;
}

async function addChat(db, ownerId, projectId = null) {
  const id = randomUUID();
  await db.query("INSERT INTO chats(id,owner_id,title,history,project_id) VALUES($1,$2,'Owned chat','[]',$3)", [id, ownerId, projectId]);
  const messageId = randomUUID();
  await db.query("INSERT INTO chat_messages(id,chat_id,role,content,events) VALUES($1,$2,'user','A saved question','[]')", [messageId, id]);
  await db.query("INSERT INTO chat_attachments(id,message_id,owner_id,position,name,mime_type,bytes) VALUES($1,$2,$3,0,'reference.png','image/png',$4)", [randomUUID(), messageId, ownerId, PNG]);
  return id;
}

async function addWorkflow(db, ownerId, projectId, overrides = {}) {
  const id = randomUUID();
  const plan = overrides.plan ?? false;
  await db.query(
    `INSERT INTO creative_workflows(id,owner_id,project_id,kind,brief,credit_budget,plan_title,project_revision,project_context,source_chat_id,source_chat_key,source_call_id,source_input_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, ownerId, projectId, overrides.kind ?? "thumbnail",
      JSON.stringify(overrides.brief ?? { goal: "Plan the work" }),
      overrides.creditBudget ?? 10,
      plan ? "Written plan" : null,
      plan ? 1 : null,
      plan ? JSON.stringify({ game: "Private project" }) : null,
      overrides.sourceChatId ?? null,
      overrides.sourceChatKey ?? "",
      overrides.sourceCallId ?? null,
      overrides.sourceInputHash ?? null,
    ],
  );
  return id;
}

async function addJob(db, ownerId, projectId, workflowId, status = "queued", outputAssetId = null) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO creative_jobs(id,owner_id,project_id,workflow_id,concept_key,stage,status,provider_id,provider_model,provider_mode,quoted_credits,request,output_asset_id) VALUES($1,$2,$3,$4,'concept','concept',$5,'fixture-provider','fixture-model','test',1,$6,$7)",
    [id, ownerId, projectId, workflowId, status, JSON.stringify({}), outputAssetId],
  );
  return id;
}

test("closing the signed-in owner removes every private row and keeps only accounting, history and the marker", async (t) => {
  const db = await database(t);
  const a = await newAccount(db, 111001);
  const b = await newAccount(db, 111002);

  // Public Roblox history belongs to nobody here and must survive untouched.
  await db.query("INSERT INTO history_games(universe_id,root_place_id,name,icon_url,first_seen,last_seen) VALUES($1,$2,$3,NULL,now(),now())", [900001, 800001, "Public game"]);

  // Owner A: an identity, a session, a linked game with its sealed key, metrics and
  // consents, a chat with an image, a project with an asset and a written plan, a
  // UI listing with rights and an event, and the credit grant, reserve and open hold.
  await db.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now() + interval '30 days')", [randomBytes(32).toString("hex"), a.id]);
  const gameId = randomUUID();
  await db.query("INSERT INTO linked_games(id,account_id,universe_id,collect,share) VALUES($1,$2,$3,true,false)", [gameId, a.id, 900100]);
  await db.query("INSERT INTO linked_game_keys(game_id,key_version,iv,ciphertext,tag,hint) VALUES($1,1,$2,$3,$4,'abcd')", [gameId, Buffer.alloc(12), Buffer.from("sealed-private-key"), Buffer.alloc(16)]);
  await db.query("INSERT INTO linked_game_metrics(game_id,metric,day,value,status) VALUES($1,'dau','2026-09-01',12.5,'Projected')", [gameId]);
  await db.query("INSERT INTO linked_game_consents(account_id,universe_id,setting,enabled,notice) VALUES($1,$2,'collect',true,'linked-games-1')", [a.id, 900100]);

  const projectId = await addProject(db, a.ownerId, "Private project");
  const assetId = await addAsset(db, a.ownerId, projectId);
  const chatId = await addChat(db, a.ownerId, projectId);
  await addWorkflow(db, a.ownerId, projectId, { plan: true, sourceChatId: chatId, sourceChatKey: "chat-key", sourceCallId: "call-1", sourceInputHash: PNG_SHA });
  const entryId = randomUUID();
  await db.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft','Listing','A draft',ARRAY['mobile'],NULL,$4)", [entryId, a.ownerId, projectId, JSON.stringify({ tray: assetId })]);
  await db.query("INSERT INTO ui_library_sources(entry_id,asset_id) VALUES($1,$2)", [entryId, assetId]);
  await db.query("INSERT INTO ui_asset_rights(asset_id,owner_id,project_id,status,license,attribution,evidence_private) VALUES($1,$2,$3,'granted','CC-BY-4.0','Owner','private evidence')", [assetId, a.ownerId, projectId]);
  await db.query("INSERT INTO ui_library_events(entry_id,owner_id,action,revision) VALUES($1,$2,'shared',1)", [entryId, a.ownerId]);
  const finishedWorkflow = await addWorkflow(db, a.ownerId, projectId);
  const finishedJob = await addJob(db, a.ownerId, projectId, finishedWorkflow, "succeeded", assetId);
  await db.query(`INSERT INTO creative_reviews(id,owner_id,project_id,workflow_id,job_id,asset_id,reviewer_id,reviewer_model,reviewer_mode,asset_sha256,status,claim_id,approved,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,'fixture','fixture','test',$7,'approved',$8,true,now())`, [randomUUID(), a.ownerId, projectId, finishedWorkflow, finishedJob, assetId, PNG_SHA, randomUUID()]);
  await db.query(`INSERT INTO creative_reconciliations(id,job_id,owner_id,project_id,operator_id,evidence_id,outcome,actual_credits,output_asset_id,fingerprint)
    VALUES($1,$2,$3,$4,'fixture-operator','fixture-evidence','recovered',1,$5,$6)`, [randomUUID(), finishedJob, a.ownerId, projectId, assetId, PNG_SHA]);
  const runId = randomUUID();
  await db.query("INSERT INTO agent_runs(id,owner_id,project_id,objective,context,allowed_tools,max_steps,status) VALUES($1,$2,$3,'Private objective','[]','[]',5,'completed')", [runId, a.ownerId, projectId]);
  await db.query("INSERT INTO agent_actions(id,run_id,sequence,tool_name,tool_version,tool_scope,effect,input,reason,digest,status) VALUES($1,$2,1,'fixture','1','project','read','{}','Private reason','digest','succeeded')", [randomUUID(), runId]);

  await grantCredits(db, { ownerId: a.ownerId, amount: 200, operationId: `fixture-grant:${a.ownerId}` });
  const hold = await reserveUsage(db, { ownerId: a.ownerId, feature: "chat", maxPriceNanoUsd: 49_500_000, pricingPolicyVersion: LEGACY_PRICING_POLICY });
  const reserveOperation = `fixture-reserve:${a.ownerId}`;
  await reserveCredits(db, { ownerId: a.ownerId, operationId: reserveOperation, amount: 10 });

  // Owner B has its own private content that must not be touched.
  const bProject = await addProject(db, b.ownerId, "Other private project");
  await addAsset(db, b.ownerId, bProject);
  await addChat(db, b.ownerId, bProject);
  await grantCredits(db, { ownerId: b.ownerId, amount: 50, operationId: `other-grant:${b.ownerId}` });

  const ledgerBefore = await count(db, "credits_ledger");
  const operationsBefore = await count(db, "credits_operations");
  await closeAccount(db, { id: a.id, ownerId: a.ownerId });

  // The identity, its session, linked game records and every private row are gone.
  assert.equal(await count(db, "accounts", "id=$1", [a.id]), 0);
  assert.equal(await count(db, "accounts", "roblox_user_id=$1", [a.robloxUserId]), 0);
  assert.equal(await count(db, "account_sessions", "account_id=$1", [a.id]), 0);
  assert.equal(await count(db, "linked_games", "account_id=$1", [a.id]), 0);
  assert.equal(await count(db, "linked_game_keys"), 0);
  assert.equal(await count(db, "linked_game_metrics"), 0);
  assert.equal(await count(db, "linked_game_consents", "account_id=$1", [a.id]), 0);
  for (const table of ["creative_projects", "creative_assets", "creative_workflows", "creative_jobs", "creative_reviews", "creative_reconciliations", "agent_runs", "ui_library_entries", "ui_library_events", "ui_asset_rights", "chats", "chat_attachments"]) {
    assert.equal(await count(db, table, "owner_id=$1", [a.ownerId]), 0, `${table} still has the closed owner's rows`);
  }
  assert.equal(await count(db, "chat_messages", "chat_id=$1", [chatId]), 0);
  assert.equal(await count(db, "agent_actions", "run_id=$1", [runId]), 0);
  assert.equal(await count(db, "ui_library_sources"), 0);

  // The marker outlives the account and contains internal identifiers only.
  const closures = await rows(db, "SELECT owner_id, account_id FROM account_closures");
  assert.deepEqual(closures.map((row) => [row.owner_id, row.account_id]), [[a.ownerId, a.id]]);
  const columns = (await rows(db, "SELECT column_name FROM information_schema.columns WHERE table_name='account_closures' ORDER BY column_name")).map((row) => row.column_name);
  assert.deepEqual(columns, ["account_id", "closed_at", "owner_id"]);
  assert.equal(await isClosedOwner(db, a.ownerId), true);

  // Minimal accounting is retained: the immutable ledger and its rows are intact,
  // and the open hold still waits for its settlement.
  assert.equal(await count(db, "credits_accounts", "owner_id=$1", [a.ownerId]), 1);
  assert.equal(await count(db, "credits_ledger"), ledgerBefore);
  assert.equal(await count(db, "credits_operations"), operationsBefore);
  assert.equal(await count(db, "usage_holds", "owner_id=$1 AND status='reserved'", [a.ownerId]), 1);
  assert.deepEqual(await getBalance(db, { ownerId: a.ownerId }), { ownerId: a.ownerId, balance: 200, reserved: 16, available: 184 });
  assert.equal(Number((await rows(db, "SELECT reserved_credits FROM usage_holds WHERE id=$1", [hold.id]))[0].reserved_credits), 6);

  // The other owner's data and the shared public history are untouched.
  assert.equal(await count(db, "accounts", "id=$1", [b.id]), 1);
  for (const table of ["creative_projects", "creative_assets", "chats", "chat_attachments"]) {
    assert.equal(await count(db, table, "owner_id=$1", [b.ownerId]), 1, `${table} lost the other owner's rows`);
  }
  assert.equal(await isClosedOwner(db, b.ownerId), false);
  assert.equal(await count(db, "history_games", "universe_id=$1", [900001]), 1);
});

test("a closed owner cannot start new work but its open reservation still settles", async (t) => {
  const db = await database(t);
  const a = await newAccount(db, 222001);
  await addProject(db, a.ownerId);
  await grantCredits(db, { ownerId: a.ownerId, amount: 200, operationId: "grant" });
  const hold = await reserveUsage(db, { ownerId: a.ownerId, feature: "chat", maxPriceNanoUsd: 75_000_000 });
  const reserveOperation = "reserve";
  await reserveCredits(db, { ownerId: a.ownerId, operationId: reserveOperation, amount: 10 });

  await closeAccount(db, { id: a.id, ownerId: a.ownerId });

  // A stale write, grant, reservation or hold for the closed owner is refused.
  await rejectsStaleWrite(db.query("INSERT INTO chats(id,owner_id,title,history) VALUES($1,$2,'Stale chat','[]')", [randomUUID(), a.ownerId]));
  await rejectsStaleWrite(db.query("INSERT INTO creative_projects(id,owner_id,name,context) VALUES($1,$2,'Stale project','{}')", [randomUUID(), a.ownerId]));
  await rejectsStaleWrite(grantCredits(db, { ownerId: a.ownerId, amount: 10, operationId: "stale-grant" }));
  await rejectsStaleWrite(reserveCredits(db, { ownerId: a.ownerId, operationId: "stale-reserve", amount: 1 }));
  await rejectsStaleWrite(reserveUsage(db, { ownerId: a.ownerId, feature: "ask", maxPriceNanoUsd: 1_000_000 }));
  assert.equal(await count(db, "chats", "owner_id=$1", [a.ownerId]), 0);
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [a.ownerId]), 0);

  // The work already reserved before closure still settles exactly once.
  const settledUsage = await settleUsage(db, { ownerId: a.ownerId, id: hold.id, call: heavyCall() });
  assert.equal(settledUsage.charged, 7);
  await settleReservation(db, { ownerId: a.ownerId, operationId: reserveOperation, actualCost: 10 });
  assert.deepEqual(await getBalance(db, { ownerId: a.ownerId }), { ownerId: a.ownerId, balance: 183, reserved: 0, available: 183 });
  assert.equal(await count(db, "usage_charges", "owner_id=$1", [a.ownerId]), 1);
});

test("closure is idempotent, never leaks a removed account, and validates its input", async (t) => {
  const db = await database(t);
  const a = await newAccount(db, 333001);
  const b = await newAccount(db, 333002);
  await closeAccount(db, { id: a.id, ownerId: a.ownerId });

  // A retry by the same owner succeeds; another owner learns nothing.
  await closeAccount(db, { id: a.id, ownerId: a.ownerId });
  await rejectsClosure(closeAccount(db, { id: a.id, ownerId: b.ownerId }), "not_found");
  await rejectsClosure(closeAccount(db, { id: randomUUID(), ownerId: a.ownerId }), "not_found");
  await rejectsClosure(closeAccount(db, { id: "not-a-uuid", ownerId: a.ownerId }), "invalid");
  await rejectsClosure(closeAccount(db, { id: a.id, ownerId: "" }), "invalid");
  await rejectsClosure(closeAccount(db, { id: a.id, ownerId: "x".repeat(201) }), "invalid");
  assert.equal(await count(db, "account_closures"), 1);
  assert.equal(await isClosedOwner(db, "guest:not-closed"), false);
});

test("an unfinished image job, review or agent run blocks closure and changes nothing", async (t) => {
  const fixtures = {
    "queued image job": async (db, ownerId, projectId) => {
      const workflowId = await addWorkflow(db, ownerId, projectId);
      await addJob(db, ownerId, projectId, workflowId, "queued");
    },
    "claimed review": async (db, ownerId, projectId) => {
      const assetId = await addAsset(db, ownerId, projectId, "generated");
      const workflowId = await addWorkflow(db, ownerId, projectId);
      const jobId = await addJob(db, ownerId, projectId, workflowId, "succeeded", assetId);
      await db.query(
        "INSERT INTO creative_reviews(id,owner_id,project_id,workflow_id,job_id,asset_id,reviewer_id,reviewer_model,reviewer_mode,asset_sha256,status,claim_id) VALUES($1,$2,$3,$4,$5,$6,'reviewer','fixture-model','test',$7,'claimed',$8)",
        [randomUUID(), ownerId, projectId, workflowId, jobId, assetId, PNG_SHA, randomUUID()],
      );
    },
    "running agent run": async (db, ownerId, projectId) => {
      await db.query("INSERT INTO agent_runs(id,owner_id,project_id,objective,context,allowed_tools,max_steps,status) VALUES($1,$2,$3,'Do the work','[]','[]',5,'running')", [randomUUID(), ownerId, projectId]);
    },
  };
  for (const [name, build] of Object.entries(fixtures)) {
    const db = await database(t);
    const a = await newAccount(db, 444001);
    const projectId = await addProject(db, a.ownerId);
    await build(db, a.ownerId, projectId);
    await rejectsClosure(closeAccount(db, { id: a.id, ownerId: a.ownerId }), "unfinished_work");
    assert.equal(await count(db, "accounts", "id=$1", [a.id]), 1, `${name}: the account was removed`);
    assert.equal(await count(db, "account_closures"), 0, `${name}: a closure marker was written`);
    assert.equal(await count(db, "creative_projects", "owner_id=$1", [a.ownerId]), 1, `${name}: private content was removed`);
  }
});

test("another owner's reuse of a shared asset or entry blocks closure without any mutation", async (t) => {
  const db = await database(t);
  const a = await newAccount(db, 555001);
  const b = await newAccount(db, 555002);
  const aProject = await addProject(db, a.ownerId);
  const aAsset = await addAsset(db, a.ownerId, aProject);
  const aEntry = randomUUID();
  await db.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft','Owned listing','Owned',ARRAY[]::text[],NULL,$4)", [aEntry, a.ownerId, aProject, JSON.stringify({ tray: aAsset })]);
  const bProject = await addProject(db, b.ownerId, "Other project");
  const bEntry = randomUUID();
  await db.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft','Derived listing','Derived',ARRAY[]::text[],NULL,'{}')", [bEntry, b.ownerId, bProject]);

  // Another owner's dependency on this owner's entry.
  await db.query("INSERT INTO ui_library_dependencies(entry_id,source_entry_id) VALUES($1,$2)", [bEntry, aEntry]);
  await rejectsClosure(closeAccount(db, { id: a.id, ownerId: a.ownerId }), "shared_assets");

  // Another owner's source row on this owner's asset.
  await db.query("DELETE FROM ui_library_dependencies WHERE entry_id=$1", [bEntry]);
  await db.query("INSERT INTO ui_library_sources(entry_id,asset_id) VALUES($1,$2)", [bEntry, aAsset]);
  await rejectsClosure(closeAccount(db, { id: a.id, ownerId: a.ownerId }), "shared_assets");

  // Nothing was deleted or rewritten while the shared copy still points here.
  assert.equal(await count(db, "accounts", "id=$1", [a.id]), 1);
  assert.equal(await count(db, "account_closures"), 0);
  assert.equal(await count(db, "creative_assets", "owner_id=$1", [a.ownerId]), 1);
  assert.equal(await count(db, "ui_library_entries", "owner_id=$1", [a.ownerId]), 1);
  assert.equal(await count(db, "ui_library_sources", "entry_id=$1", [bEntry]), 1);

  // Once the other owner's copy no longer cites this owner, the closure succeeds.
  await db.query("DELETE FROM ui_library_sources WHERE entry_id=$1", [bEntry]);
  await closeAccount(db, { id: a.id, ownerId: a.ownerId });
  assert.equal(await count(db, "ui_library_entries", "owner_id=$1", [a.ownerId]), 0);
  assert.equal(await count(db, "ui_library_entries", "owner_id=$1", [b.ownerId]), 1);
});

test("a deletion that fails rolls the whole closure back", async (t) => {
  const db = await database(t);
  const a = await newAccount(db, 666001);
  const projectId = await addProject(db, a.ownerId);
  const chatId = await addChat(db, a.ownerId, projectId);
  const failing = {
    ...db,
    transaction: (operation) => db.transaction((sql) => operation({
      ...sql,
      query: (text, values) => {
        if (/^\s*DELETE FROM creative_projects\b/i.test(text)) throw new Error("Injected deletion failure");
        return sql.query(text, values);
      },
    })),
  };
  await assert.rejects(closeAccount(failing, { id: a.id, ownerId: a.ownerId }), /Injected deletion failure/);
  assert.equal(await count(db, "accounts", "id=$1", [a.id]), 1);
  assert.equal(await count(db, "account_closures"), 0);
  assert.equal(await count(db, "creative_projects", "owner_id=$1", [a.ownerId]), 1);
  assert.equal(await count(db, "chats", "id=$1", [chatId]), 1);
});
