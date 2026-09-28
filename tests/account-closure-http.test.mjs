import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { accountClosureResponse } from "../src/lib/accounts/closure-http.ts";
import { signInAccount, startSession, sessionAccount } from "../src/lib/accounts/store.ts";
import { welcomeAccount } from "../src/lib/credits/account.ts";
import { getBalance } from "../src/lib/credits/ledger.ts";

const origin = "https://romanum.test";
const account = { id: randomUUID(), ownerId: "account:http-test" };
const valid = (id = account.id) => ({ confirmation: "DELETE", accountId: id });
const request = (body = valid(), headers = {}) => new Request(`${origin}/api/account/delete`, {
  method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const dependencies = (changes = {}) => ({ account: async () => account, database: async () => assert.fail("storage must not be accessed"), clearCookies: async () => assert.fail("cookies must not change"), origin: () => origin, ...changes });

test("account deletion requires same-origin JSON and the exact signed-in account confirmation", async () => {
  const deps = dependencies();
  for (const headers of [{ origin: "https://other.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await accountClosureResponse(request(valid(), headers), deps);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await accountClosureResponse(new Request(origin), deps)).status, 405);
  assert.equal((await accountClosureResponse(request(valid(), { "content-type": "text/plain" }), deps)).status, 400);
  assert.equal((await accountClosureResponse(request(), dependencies({ account: async () => null }))).status, 401);
  for (const body of [valid(randomUUID()), { ...valid(), confirmation: "delete" }, { ...valid(), ownerId: account.ownerId }, [], null]) {
    assert.equal((await accountClosureResponse(request(body), deps)).status, 409);
  }
  assert.equal((await accountClosureResponse(request("{"), deps)).status, 400);
  assert.equal((await accountClosureResponse(request(" ".repeat(1025)), deps)).status, 413);
});

test("deletion failures are private and never clear a still-active session", async () => {
  for (const database of [async () => null, async () => { throw new Error("postgres://secret@host/db"); }]) {
    const response = await accountClosureResponse(request(), dependencies({ database }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(await response.text(), /postgres|secret|host/);
  }
});

test("HTTP closure revokes all sessions and repeat Roblox sign-in cannot reopen old data or reclaim a bonus", async t => {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const profile = { userId: 780001, username: "closure-test", displayName: "Closure test", pictureUrl: null };
  const guest = `guest:${randomUUID()}`;
  const { account: original } = await signInAccount(db, profile, guest);
  assert.equal(original.ownerId, guest);
  assert.equal((await getBalance(db, { ownerId: guest })).available, 200);
  const sessions = [await startSession(db, original.id), await startSession(db, original.id)];
  const chatId = randomUUID();
  await db.query("INSERT INTO chats(id,owner_id,title) VALUES($1,$2,'Private before deletion')", [chatId, guest]);
  let cleared = 0;
  const deps = dependencies({ account: () => sessionAccount(db, sessions[0].token), database: async () => db, clearCookies: async () => { cleared++; } });
  // An account switch in another tab must never delete the newly signed-in account.
  assert.equal((await accountClosureResponse(request(valid()), deps)).status, 409);
  assert.ok(await sessionAccount(db, sessions[0].token));
  const result = await accountClosureResponse(request(valid(original.id)), deps);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { deleted: true });
  assert.equal(cleared, 1);
  for (const session of sessions) assert.equal(await sessionAccount(db, session.token), null);
  assert.equal((await db.query("SELECT 1 FROM chats WHERE id=$1", [chatId])).rows.length, 0);
  assert.equal((await accountClosureResponse(request(valid(original.id)), deps)).status, 401);

  const returned = await signInAccount(db, profile, guest);
  assert.notEqual(returned.account.id, original.id);
  assert.notEqual(returned.account.ownerId, guest);
  assert.equal(returned.adoptedGuest, false);
  assert.equal((await welcomeAccount(db, returned.account.id)).available, 50);
  assert.equal((await signInAccount(db, profile, guest)).account.id, returned.account.id);
  assert.equal((await getBalance(db, { ownerId: returned.account.ownerId })).available, 50);
  const grants = await db.query("SELECT owner_id FROM credits_operations WHERE operation_id=$1", [`signup:roblox:${profile.userId}`]);
  assert.deepEqual(grants.rows, [{ owner_id: guest }]);
  // Even a different Roblox account cannot adopt a deleted guest's signed cookie.
  const other = await signInAccount(db, { ...profile, userId: 780002 }, guest);
  assert.notEqual(other.account.ownerId, guest);
  assert.equal(other.adoptedGuest, false);
});
