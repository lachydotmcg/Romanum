import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { GUEST_WELCOME_CREDITS, welcomeGuest } from "../src/lib/credits/guest.ts";
import { CENTS_PER_CREDIT, compactCredits, creditsInDollars } from "../src/lib/credits/value.ts";

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", "002_credits.sql"), "utf8"));
  return db;
}

test("each guest gets its 50 welcome credits once, however often it asks", async (t) => {
  const db = await database(t);
  assert.equal(GUEST_WELCOME_CREDITS, 50);
  const first = await welcomeGuest(db, "guest:a");
  assert.deepEqual(first, { ownerId: "guest:a", balance: 50, reserved: 0, available: 50 });
  assert.deepEqual(await welcomeGuest(db, "guest:a"), first);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM credits_ledger WHERE owner_id='guest:a'")).rows[0].count, 1);
  assert.equal((await welcomeGuest(db, "guest:b")).available, 50);
});

test("a credit is worth one US cent", () => {
  assert.equal(CENTS_PER_CREDIT, 1);
  assert.equal(creditsInDollars(50), "$0.50");
  assert.equal(creditsInDollars(1250), "$12.50");
  assert.equal(compactCredits(50), "50");
  assert.equal(compactCredits(1250), "1.3K");
});
