import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { accountRecommendationContext, guestRecommendationContext } from "../src/lib/models/preference-context.ts";

const route = new URL("../src/app/api/models/preferences/route.ts", import.meta.url).href;
const virtual = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === route) {
    if (specifier === "next/headers") return virtual(`export async function cookies(){return {has:()=>globalThis.__preferences.session};}`);
    if (specifier === "@/lib/accounts/session") return virtual('export const SESSION_COOKIE="romanum_session"; export async function readAccount(){if(globalThis.__preferences.accountError)throw new Error("Fixture outage"); return globalThis.__preferences.account??null;}');
    if (specifier === "@/lib/guest") return virtual(`export async function readGuest(){globalThis.__preferences.reads++;if(globalThis.__preferences.error)throw new Error("Fixture outage");return globalThis.__preferences.guest;}`);
    if (specifier === "@/lib/history/database") return virtual(`export async function historyDatabase(){if(globalThis.__preferences.noDatabase)return null;return {query:async(sql,params)=>{globalThis.__preferences.queries.push({sql,params});if(globalThis.__preferences.databaseError)throw new Error("Fixture outage");return {rows:globalThis.__preferences.plan===undefined?[]:[{credit_plan:globalThis.__preferences.plan}]};}};}`);
    if (specifier.startsWith("@/lib/models/")) return { url: new URL(`../src/lib/models/${specifier.split("/").at(-1)}.ts`, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { GET } = await import(route);
hooks.deregister();
const guest = "guest:01234567-89ab-4cde-8123-456789abcdef";

test("read-only preference context verifies an existing guest and exposes only an opaque browser scope", async t => {
  globalThis.__preferences = { session: false, guest, reads: 0 };
  t.after(() => delete globalThis.__preferences);
  const response = await GET(), context = await response.json();
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(context.subscription, "none"); assert.match(context.scope, /^[a-f0-9]{64}$/);
  assert.equal(globalThis.__preferences.reads, 1);
  assert.deepEqual(Object.keys(context).sort(), ["scope", "subscription"]);
  assert.ok(!JSON.stringify(context).includes(guest));
  assert.deepEqual(context, guestRecommendationContext(false, guest));
  assert.notEqual(context.scope, guestRecommendationContext(false, guest.replace("01234567", "11234567")).scope);
});

test("account cookies, failed/missing guest identity and malformed owner scopes remain unknown", async t => {
  t.after(() => delete globalThis.__preferences);
  for (const fixture of [{ session: true, guest }, { session: false, guest: null }, { session: false, guest, error: true },
    { session: false, guest: "account:fixture" }, { session: false, guest: "guest:bad" }]) {
    globalThis.__preferences = { reads: 0, ...fixture };
    assert.deepEqual(await (await GET()).json(), { subscription: "unknown", scope: null });
    if (fixture.session) assert.equal(globalThis.__preferences.reads, 0);
  }
});

test("verified free and subscribed accounts use the existing authoritative credit_plan without changing billing or access", async t => {
  t.after(() => delete globalThis.__preferences);
  const account = { id: "11234567-89ab-4cde-8123-456789abcdef", ownerId: "account:21234567-89ab-4cde-8123-456789abcdef" };
  for (const [plan, subscription] of [["free", "none"], ["subscribed", "active"]]) {
    globalThis.__preferences = { session: true, guest, account, plan, reads: 0, queries: [] };
    const response = await GET(), context = await response.json();
    assert.equal(context.subscription, subscription); assert.match(context.scope, /^[a-f0-9]{64}$/);
    assert.equal(globalThis.__preferences.reads, 0);
    assert.deepEqual(globalThis.__preferences.queries, [{ sql: "SELECT credit_plan FROM accounts WHERE id=$1 AND owner_id=$2", params: [account.id, account.ownerId] }]);
    assert.deepEqual(context, accountRecommendationContext(account.ownerId, plan));
    assert.ok(!JSON.stringify(context).includes(account.id));
  }
  assert.equal(accountRecommendationContext(guest, "free").scope, guestRecommendationContext(false, guest).scope,
    "an account that adopts the guest owner keeps the same acknowledgement scope");
});

test("account lookup failure, deleted/missing plan rows and unknown flags never fall back to a free guest", async t => {
  t.after(() => delete globalThis.__preferences);
  const account = { id: "11234567-89ab-4cde-8123-456789abcdef", ownerId: guest };
  for (const extra of [{ account: null }, { account, noDatabase: true }, { account, databaseError: true },
    { account, plan: undefined }, { account, plan: "unexpected" }, { account, plan: null }, { accountError: true }]) {
    globalThis.__preferences = { session: true, guest, reads: 0, queries: [], ...extra };
    assert.deepEqual(await (await GET()).json(), { subscription: "unknown", scope: null });
    assert.equal(globalThis.__preferences.reads, 0);
  }
});
