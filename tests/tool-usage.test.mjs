import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { grantCredits, getBalance } from "../src/lib/credits/ledger.ts";
import { reserveToolUsage, finishToolUsage } from "../src/lib/credits/tool-usage.ts";
import { BILLED_TOOLS, TOOL_FEE_CREDITS } from "../src/lib/credits/tool-pricing.ts";
import { assistantBilling } from "../src/lib/assistant/billing.ts";
import { reserveUsage, settleUsage } from "../src/lib/credits/usage-holds.ts";
import { runAssistant } from "../src/lib/assistant/engine.ts";
import { newTurn, applyEvent, finishTurn } from "../src/components/assistant/turns.ts";

async function database(t, amount = 50) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "010_usage.sql", "014_usage_holds.sql", "018_tool_usage.sql"]) await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  if (amount) await grantCredits(db, { ownerId: "owner", amount, operationId: "welcome" });
  return db;
}
const reserve = db => reserveToolUsage(db, { ownerId: "owner", feature: "chat", tool: "load_skill" });
const finish = (db, id, success = true) => finishToolUsage(db, { ownerId: "owner", id, success });
const ok = async () => ({ ok: true, result: { games: [] }, summary: "No matches" });
const signal = () => new AbortController().signal;
const carry = async db => Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id='owner'")).rows[0].carry_nano_usd);

test("successful lookups bill exactly 0.06 each, accumulating without per-call rounding", async t => {
  const db = await database(t);
  const billing = assistantBilling(db, "owner", "ask");
  for (let i = 0; i < 50; i++) await billing.tool(BILLED_TOOLS[i % BILLED_TOOLS.length], ok, signal());
  assert.ok(Math.abs(billing.credits - 3) < 1e-10);
  assert.equal(TOOL_FEE_CREDITS, 0.06);
  assert.deepEqual(await getBalance(db, { ownerId: "owner" }), { ownerId: "owner", balance: 47, reserved: 0, available: 47 });
  assert.equal(await carry(db), 0);
  const charges = (await db.query("SELECT calls,tools,price_nano_usd,cost_nano_usd FROM usage_charges")).rows;
  assert.equal(charges.length, 50);
  assert.ok(charges.every(row => Number(row.price_nano_usd) === 600000 && Number(row.cost_nano_usd) === 0 && row.calls.length === 0 && row.tools.length === 1));
});

test("concurrent tools share model carry and all appear in the answer cost", async t => {
  const db = await database(t);
  const model = await reserveUsage(db, { ownerId: "owner", feature: "ask", maxPriceNanoUsd: 15_000_000 });
  const billing = assistantBilling(db, "owner", "chat");
  await Promise.all([
    ...BILLED_TOOLS.map(tool => billing.tool(tool, ok, signal())),
    settleUsage(db, { ownerId: "owner", id: model.id, call: { model: "deepseek-flash", at: new Date("2026-09-28T02:00:00Z"), input: 20000, cachedInput: 0, output: 0 } }),
  ]);
  assert.ok(Math.abs(billing.credits - BILLED_TOOLS.length * TOOL_FEE_CREDITS) < 1e-10);
  assert.equal(await carry(db), (15_000_000 + BILLED_TOOLS.length * 600_000) % 10_000_000);
  assert.equal((await getBalance(db, { ownerId: "owner" })).available, 48);
});

test("settlement replays once and rejects another owner or conflicting outcome", async t => {
  const db = await database(t), id = await reserve(db);
  assert.equal(await finish(db, id), 0.06);
  assert.equal(await finish(db, id), 0.06);
  await assert.rejects(finish(db, id, false), { code: "conflict" });
  await assert.rejects(finishToolUsage(db, { ownerId: "other", id, success: true }), { code: "not_found" });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM usage_charges")).rows[0].n, 1);
  assert.equal(await carry(db), 600000);
  const released = await reserve(db);
  assert.equal(await finish(db, released, false), 0);
  assert.equal(await finish(db, released, false), 0);
  await assert.rejects(finish(db, released), { code: "conflict" });
});

test("invalid, failed, unavailable and cancelled tools release their holds", async t => {
  const db = await database(t), billing = assistantBilling(db, "owner", "chat");
  await billing.tool("load_skill", async () => ({ ok: false, error: "Invalid arguments" }), signal());
  await billing.tool("research_game_idea", async () => ({ ok: true, result: { status: "unavailable" }, summary: "Unavailable" }), signal());
  await assert.rejects(billing.tool("search_games", async () => { throw new Error("offline"); }, signal()), /offline/);
  const controller = new AbortController();
  await billing.tool("get_game_stats", async () => { controller.abort(); return ok(); }, controller.signal);
  await assert.rejects(billing.tool("load_skill", ok, controller.signal), { name: "AbortError" });
  assert.equal(billing.credits, 0);
  assert.equal((await getBalance(db, { ownerId: "owner" })).available, 50);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tool_usage WHERE status='released'")).rows[0].n, 4);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM usage_charges")).rows[0].n, 0);
});

test("unfunded tools never execute, concurrent holds cannot overspend", async t => {
  const db = await database(t, 1);
  const holds = await Promise.allSettled([reserve(db), reserve(db)]);
  assert.equal(holds.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(holds.find(r => r.status === "rejected").reason.code, "insufficient_balance");
  const billing = assistantBilling(db, "owner", "ask");
  await assert.rejects(billing.tool("search_games", async () => assert.fail("must not execute"), signal()), { code: "insufficient_balance" });
  await finish(db, holds.find(r => r.status === "fulfilled").value, false);
  assert.equal((await getBalance(db, { ownerId: "owner" })).available, 1);
});

test("charts, metric definitions and project actions have no tool surcharge", async t => {
  const db = await database(t, 0), billing = assistantBilling(db, "owner", "ask");
  for (const name of ["create_chart", "get_metric_definitions", "resolve_game_link", "save_project_context", "save_asset_plan"]) {
    assert.equal((await billing.tool(name, ok, signal())).ok, true);
    await assert.rejects(reserveToolUsage(db, { ownerId: "owner", feature: "ask", tool: name }), { code: "invalid_input" });
  }
  assert.equal(billing.credits, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tool_usage")).rows[0].n, 0);
});

test("a failed accounting write rolls back the fee, carry and capture together", async t => {
  const db = await database(t), id = await reserve(db);
  const failing = { ...db, transaction: fn => db.transaction(sql => fn({ ...sql, query: (text, values) => {
    if (text.startsWith("INSERT INTO usage_charges")) throw new Error("write failure");
    return sql.query(text, values);
  } })) };
  await assert.rejects(finish(failing, id), /write failure/);
  assert.equal((await getBalance(db, { ownerId: "owner" })).reserved, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM usage_carry")).rows[0].n, 0);
  assert.equal(await finish(db, id), 0.06);
});

test("the shared model loop charges successful skills without revealing tariff instructions to the model", async t => {
  const db = await database(t), billing = assistantBilling(db, "owner", "ask"), events = [], requests = [];
  let step = 0;
  const client = { chat: { completions: { create: async request => {
    requests.push(request); const index = step++;
    return (async function* () {
      yield { choices: [{ delta: index === 0 ? { tool_calls: [
        { index: 0, id: "skill", function: { name: "load_skill", arguments: '{"skill":"romanum-game-design"}' } },
        { index: 1, id: "invalid", function: { name: "load_skill", arguments: '{"skill":"not-a-skill"}' } },
        { index: 2, id: "definitions", function: { name: "get_metric_definitions", arguments: '{}' } },
      ] } : { content: "Start with a short racing prototype." } }] };
      yield { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    })();
  } } } };
  await runAssistant({ client, billing, conversation: [{ role: "user", content: "Plan a racing game" }], send: e => events.push(e), signal: signal() });
  assert.equal(events.at(-1).type, "done");
  assert.equal(billing.credits, 0.06);
  assert.equal(events.filter(e => e.type === "tool_end" && e.ok).length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /0\.06|tool tariff|tool surcharge/);
});

test("a server credit error survives stream EOF and the final usage event", () => {
  let turn = newTurn("turn", "question");
  turn = applyEvent(turn, { type: "error", message: "Not enough credits for the next step." }, 1);
  turn = applyEvent(turn, { type: "usage", credits: 0.12 }, 2);
  turn = finishTurn(turn, 3, "The response ended unexpectedly.");
  assert.equal(turn.error, "Not enough credits for the next step.");
  assert.equal(turn.credits, 0.12);
  assert.equal(turn.done, true);
});
