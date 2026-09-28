import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { unzipSync, strFromU8 } from "fflate";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { accountExportResponse } from "../src/lib/accounts/export-http.ts";
import { buildAccountArchive } from "../src/lib/accounts/export-archive.ts";

const account = { id: randomUUID(), ownerId: "account:export-http" };
const imageId = randomUUID();
const request = (query = "", headers = {}) => new Request(`https://romanum.test/api/account/export${query}`, { headers });
const privateHeaders = { "X-Romanum-Export-Account": account.id };
const response = (value, headers = {}) => Response.json(value, { headers: { ...privateHeaders, ...headers } });

test("export HTTP refuses guests, cross-origin access and account switches, without opening storage", async () => {
  let reads = 0;
  const deps = { account: async () => account, database: async () => { reads++; throw new Error("do not read"); } };
  for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "https://other.test" }]) {
    const result = await accountExportResponse(request("?section=profile", headers), deps);
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal((await accountExportResponse(request(), { ...deps, account: async () => null })).status, 401);
  assert.equal((await accountExportResponse(request(), { ...deps, account: async () => { throw new Error("private provider credentials"); } })).status, 503);
  assert.equal((await accountExportResponse(request("?section=profile", { "x-romanum-export-account": randomUUID() }), deps)).status, 409);
  assert.equal((await accountExportResponse(new Request("https://romanum.test", { method: "POST" }), deps)).status, 405);
  assert.equal(reads, 0);
  const manifest = await accountExportResponse(request(), deps);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("x-content-type-options"), "nosniff");
  assert.equal(manifest.headers.get("vary"), "Cookie");
  const body = await manifest.json();
  assert.equal(body.format, "romanum-data-v1");
  assert.ok(!body.sections.includes("linked_game_keys"));
  assert.ok(!body.sections.includes("account_sessions"));
});

test("an actual account exports through HTTP into a readable ZIP with byte-exact images", async (t) => {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))) };
  await migrateHistory(db);
  await db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,987,'download-test','Download test')", [account.id, account.ownerId]);
  const chatId = randomUUID(), messageId = randomUUID();
  await db.query("INSERT INTO chats(id,owner_id,title) VALUES($1,$2,'My own chat')", [chatId, account.ownerId]);
  await db.query("INSERT INTO chat_messages(id,chat_id,role,content) VALUES($1,$2,'user','My own question')", [messageId, chatId]);
  // Deliberately >one chunk. Export doesn't decode existing stored bytes.
  const bytes = Uint8Array.from({ length: 650_001 }, (_, i) => i % 251);
  await db.query("INSERT INTO chat_attachments(id,message_id,owner_id,position,name,mime_type,bytes) VALUES($1,$2,$3,0,'../../unsafe.png','image/png',$4)", [imageId, messageId, account.ownerId, bytes]);
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(new URL(url, "https://romanum.test"));
    return accountExportResponse(new Request(new URL(url, "https://romanum.test"), init), { account: async () => account, database: async () => db });
  };
  const blob = await buildAccountArchive({ signal: new AbortController().signal, includeImages: true, fetch: fetcher });
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(files[`images/chat/${imageId}.png`], bytes);
  assert.ok(Object.keys(files).every((path) => !path.includes("..")));
  assert.equal(JSON.parse(strFromU8(files["records/chat_messages/00001.json"]))[0].content, "My own question");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.imageCount, 1);
  assert.equal(manifest.accountId, account.id);
  assert.ok(manifest.inventory.length >= 20);
  assert.match(strFromU8(files["README.txt"]), /not from a frozen database snapshot/);
  assert.deepEqual(calls.filter((url) => url.searchParams.has("image")).map((url) => url.searchParams.get("offset")), ["0", "524288"]);
  const invalid = await accountExportResponse(request("?section=account_sessions"), { account: async () => account, database: async () => db });
  assert.equal(invalid.status, 400);
  const missing = await accountExportResponse(request(`?image=chat&id=${randomUUID()}`), { account: async () => account, database: async () => db });
  assert.equal(missing.status, 404);
});

const pages = {
  section: "chat_attachments",
  records: [{ id: imageId, name: "reference.png", mime_type: "image/png", byte_length: 3 }],
  nextCursor: null,
};
function mockFetch(onFetch) {
  return async (url, init) => {
    const params = new URL(url, "https://romanum.test").searchParams;
    if (!["section", "image"].some((key) => params.has(key))) return response({ format: "romanum-data-v1", sections: ["chat_attachments"] });
    assert.equal(init.headers["X-Romanum-Export-Account"], account.id);
    return onFetch(params, init);
  };
}

test("image exclusion is recorded and avoids binary requests", async () => {
  const blob = await buildAccountArchive({ includeImages: false, signal: new AbortController().signal, fetch: mockFetch((params) => {
    assert.ok(params.has("section")); return response(pages);
  }) });
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(!Object.keys(files).some((path) => path.startsWith("images/")));
  assert.equal(JSON.parse(strFromU8(files["manifest.json"])).includeImages, false);
});

test("partial downloads never resolve an archive after cancellation, a missing image or an account switch", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildAccountArchive({ includeImages: false, signal: controller.signal, fetch: async () => assert.fail("cancelled") }), { name: "AbortError" });
  for (const status of [401, 404, 409, 503]) {
    await assert.rejects(buildAccountArchive({ includeImages: true, signal: new AbortController().signal,
      fetch: mockFetch((params) => params.has("section") ? response(pages) : new Response("do not echo secrets", { status })) }), /Sign in|changed|unavailable/);
  }
  await assert.rejects(buildAccountArchive({ includeImages: false, signal: new AbortController().signal,
    fetch: mockFetch(() => response(pages, { "X-Romanum-Export-Account": randomUUID() })) }), /account changed/);
});

test("archive stops on looping pagination, malformed image chunks and unsafe archive paths", async () => {
  await assert.rejects(buildAccountArchive({ includeImages: false, signal: new AbortController().signal,
    fetch: mockFetch(() => response({ ...pages, nextCursor: "repeated" })) }), /stopped advancing/);
  for (const chunkHeaders of [
    { "X-Image-Type": "image/png", "X-Image-Bytes": "3", "X-Next-Offset": "1" },
    { "X-Image-Type": "image/jpeg", "X-Image-Bytes": "3", "X-Next-Offset": "done" },
    { "X-Image-Type": "image/png", "X-Image-Bytes": "4", "X-Next-Offset": "done" },
  ]) {
    await assert.rejects(buildAccountArchive({ includeImages: true, signal: new AbortController().signal,
      fetch: mockFetch((params) => params.has("section") ? response(pages) : new Response(new Uint8Array([1, 2, 3]), { headers: { ...privateHeaders, ...chunkHeaders } })) }), /interrupted/);
  }
  await assert.rejects(buildAccountArchive({ includeImages: true, signal: new AbortController().signal,
    fetch: mockFetch(() => response({ ...pages, records: [{ ...pages.records[0], id: "../../bad" }] })) }), /Invalid image/);
});
