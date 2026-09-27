import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  authorizationUrl,
  callbackUrl,
  completeSignIn,
  decodeAttempt,
  encodeAttempt,
  newSignInAttempt,
  oauthClient,
  safeNextPath,
  SignInError,
} from "../src/lib/accounts/roblox-oauth.ts";
import { endSession, sessionAccount, signInAccount, startSession } from "../src/lib/accounts/store.ts";
import { ACCOUNT_SIGNUP_CREDITS, welcomeAccount } from "../src/lib/credits/account.ts";
import { welcomeGuest } from "../src/lib/credits/guest.ts";
import { getBalance, reserveCredits, settleReservation } from "../src/lib/credits/ledger.ts";

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "012_accounts.sql"]) await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", file), "utf8"));
  return db;
}

const client = { clientId: "7290610397987934964", clientSecret: "RBX-secret" };
const NOW = Date.parse("2026-09-27T06:00:00Z");
const jwt = (claims) => `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const claims = (overrides = {}) => ({
  iss: "https://apis.roblox.com/oauth/",
  aud: client.clientId,
  sub: "2067243959",
  nonce: "n".repeat(43),
  exp: NOW / 1000 + 3600,
  iat: NOW / 1000,
  ...overrides,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for Roblox's token and userinfo endpoints that records what it was sent. */
function roblox({ idToken = claims(), userInfo = {}, tokenStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/token")) {
      return tokenStatus === 200 ? json({ access_token: "access-token-value", refresh_token: "refresh", token_type: "Bearer", expires_in: 899, id_token: jwt(idToken), scope: "openid profile" }) : json({ error: "invalid_grant" }, tokenStatus);
    }
    if (String(url).endsWith("/v1/userinfo")) {
      return json({ sub: "2067243959", name: "Links Goat", nickname: "Links Goat", preferred_username: "linksgoat", picture: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png", ...userInfo });
    }
    return json({}, 404);
  };
  return { calls, fetch };
}

const input = { code: "authorization-code", verifier: "v".repeat(43), nonce: "n".repeat(43), redirectUri: "http://localhost:3000/auth/roblox/callback" };

test("sign-in asks Roblox for openid and profile with PKCE, state and nonce, and returns only to this site", () => {
  const attempt = newSignInAttempt("/analytics?tab=1");
  const url = new URL(authorizationUrl(client, attempt, input.redirectUri));
  assert.equal(`${url.origin}${url.pathname}`, "https://apis.roblox.com/oauth/v1/authorize");
  assert.equal(url.searchParams.get("scope"), "openid profile");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), attempt.state);
  assert.equal(url.searchParams.get("nonce"), attempt.nonce);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(attempt.verifier).digest("base64url"));
  assert.equal(url.searchParams.get("client_secret"), null, "the secret never goes through the browser");
  assert.notEqual(attempt.state, attempt.nonce);

  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "profile", "", null, "/a b"]) assert.equal(safeNextPath(bad), "/profile");
  assert.equal(safeNextPath("/analytics?tab=1"), "/analytics?tab=1");

  assert.deepEqual(decodeAttempt(encodeAttempt(attempt)), attempt);
  assert.equal(decodeAttempt("not-an-attempt"), null);
  assert.equal(decodeAttempt(encodeAttempt({ ...attempt, state: "short" })), null);
  assert.equal(decodeAttempt(encodeAttempt({ ...attempt, next: "//evil.example" })).next, "/profile");

  assert.equal(oauthClient({}), null);
  assert.deepEqual(oauthClient({ ROBLOX_CLIENT_ID: " id ", ROBLOX_CLIENT_SECRET: "secret" }), { clientId: "id", clientSecret: "secret" });
  assert.equal(callbackUrl("http://localhost:3000/auth/roblox?next=/", {}), "http://localhost:3000/auth/roblox/callback");
  assert.equal(callbackUrl("http://localhost:3000/auth/roblox", { ROBLOX_REDIRECT_URI: "https://romanum.example/auth/roblox/callback" }), "https://romanum.example/auth/roblox/callback");
});

test("a completed sign-in exchanges the code server-side and returns the Roblox profile", async () => {
  const { calls, fetch } = roblox();
  const profile = await completeSignIn(client, input, { fetch, now: NOW });
  assert.deepEqual(profile, { userId: 2067243959, username: "linksgoat", displayName: "Links Goat", pictureUrl: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png" });

  const token = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(calls[0].init.method, "POST");
  assert.equal(token.get("grant_type"), "authorization_code");
  assert.equal(token.get("code"), input.code);
  assert.equal(token.get("code_verifier"), input.verifier);
  assert.equal(token.get("redirect_uri"), input.redirectUri);
  assert.equal(token.get("client_id"), client.clientId);
  assert.equal(token.get("client_secret"), client.clientSecret);
  assert.equal(calls[1].init.headers.authorization, "Bearer access-token-value");

  // A headshot from anywhere but Roblox's CDN isn't shown, and missing names fall back to the username.
  const other = await completeSignIn(client, input, { fetch: roblox({ userInfo: { picture: "https://evil.example/x.png", name: null, nickname: null } }).fetch, now: NOW });
  assert.equal(other.pictureUrl, null);
  assert.equal(other.displayName, "linksgoat");
});

test("sign-in refuses tokens for another app, user, issuer or attempt, and expired ones", async () => {
  const cases = [
    [{ idToken: claims({ nonce: "x".repeat(43) }) }, "ID token nonce mismatch"],
    [{ idToken: claims({ aud: "another-app" }) }, "ID token for another app"],
    [{ idToken: claims({ iss: "https://evil.example/" }) }, "ID token from an unexpected issuer"],
    [{ idToken: claims({ exp: NOW / 1000 - 3600 }) }, "expired ID token"],
    [{ userInfo: { sub: "1" } }, "userinfo for another user"],
    [{ tokenStatus: 400 }, "token endpoint returned 400"],
  ];
  for (const [options, reason] of cases) {
    const error = await completeSignIn(client, input, { fetch: roblox(options).fetch, now: NOW }).then(() => null, (thrown) => thrown);
    assert.ok(error instanceof SignInError, reason);
    assert.equal(error.reason, reason);
    assert.doesNotMatch(error.message, /access-token-value|authorization-code|RBX-secret/);
  }
  const unreachable = await completeSignIn(client, input, { fetch: async () => { throw new Error("offline"); }, now: NOW }).then(() => null, (thrown) => thrown);
  assert.equal(unreachable.reason, "token endpoint unreachable");
});

const profile = (overrides = {}) => ({ userId: 2067243959, username: "linksgoat", displayName: "Links Goat", pictureUrl: null, ...overrides });

test("sign-up adds 150 to the guest's remaining credits and never replenishes spending on repeat sign-ins", async t => {
  const db = await database(t), guest = `guest:${randomUUID()}`, other = `guest:${randomUUID()}`;
  assert.equal(ACCOUNT_SIGNUP_CREDITS, 150);
  await welcomeGuest(db, guest); await welcomeGuest(db, other);
  const operationId = randomUUID();
  await reserveCredits(db, { ownerId: guest, operationId, amount: 12 });
  await settleReservation(db, { ownerId: guest, operationId, actualCost: 12 });
  const { account } = await signInAccount(db, profile(), guest);
  assert.equal((await getBalance(db, { ownerId: guest })).available, 188);
  for (const guestOwnerId of [guest, other, null]) {
    await signInAccount(db, profile({ username: 'renamed' }), guestOwnerId);
    assert.equal((await welcomeAccount(db, account.id)).available, 188);
  }
  assert.equal((await getBalance(db, { ownerId: other })).available, 50);
  const grants = await db.query("SELECT amount FROM credits_operations WHERE operation_id=$1", [`signup:roblox:${profile().userId}`]);
  assert.deepEqual(grants.rows.map(row => Number(row.amount)), [150]);
});

test("direct sign-up receives 200 total; concurrent sign-ins share one account and bonus", async t => {
  const db = await database(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => signInAccount(db, profile(), null)));
  assert.equal(new Set(results.map(r => r.account.id)).size, 1);
  const { account } = results[0];
  assert.equal((await getBalance(db, { ownerId: account.ownerId })).available, 200);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_ledger WHERE owner_id=$1 AND amount=150", [account.ownerId])).rows[0].n, 1);
  const second = await signInAccount(db, profile({ userId: 42, username: 'other' }), null);
  assert.equal((await getBalance(db, { ownerId: second.account.ownerId })).available, 200);
});

test("existing accounts receive a missing sign-up bonus once on balance refresh, preserving active holds", async t => {
  const db = await database(t), id = randomUUID(), ownerId = `account:${id}`;
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name) VALUES($1,42,$2,'old','Old')", [id, ownerId]);
  await welcomeGuest(db, ownerId);
  await reserveCredits(db, { ownerId, operationId: randomUUID(), amount: 7 });
  await Promise.all(Array.from({ length: 8 }, () => welcomeAccount(db, id)));
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 200, reserved: 7, available: 193 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_operations WHERE operation_id='signup:roblox:42'")).rows[0].n, 1);
  await assert.rejects(welcomeAccount(db, randomUUID()), /Account not found/);
});

test("a failed sign-up grant rolls back the account and guest changes before a safe retry", async t => {
  const db = await database(t), guest = `guest:${randomUUID()}`;
  await welcomeGuest(db, guest);
  const failing = { ...db, transaction: operation => db.transaction(sql => operation({ ...sql, query: (query, values) => {
    if (query.startsWith('INSERT INTO credits_operations') && values[0].startsWith('signup:')) throw new Error('Injected grant failure');
    return sql.query(query, values);
  } })) };
  await assert.rejects(signInAccount(failing, profile(), guest), /Injected grant failure/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounts')).rows[0].n, 0);
  assert.equal((await getBalance(db, { ownerId: guest })).available, 50);
  await signInAccount(db, profile(), guest);
  assert.equal((await getBalance(db, { ownerId: guest })).available, 200);
});

test("a new account adopts the signing-in guest's credits and chats; later sign-ins leave other guests alone", async (t) => {
  const db = await database(t);
  const first = await signInAccount(db, profile(), "guest:11111111-1111-4111-8111-111111111111");
  assert.equal(first.adoptedGuest, true);
  assert.equal(first.account.ownerId, "guest:11111111-1111-4111-8111-111111111111");
  assert.equal(first.account.robloxUserId, 2067243959);

  const again = await signInAccount(db, profile({ displayName: "Renamed" }), "guest:22222222-2222-4222-8222-222222222222");
  assert.equal(again.adoptedGuest, false);
  assert.equal(again.account.id, first.account.id);
  assert.equal(again.account.ownerId, first.account.ownerId);
  assert.equal(again.account.displayName, "Renamed");

  // A guest another account already adopted can't be adopted again; without a guest, the account keys its own data.
  const second = await signInAccount(db, profile({ userId: 42, username: "other" }), "guest:11111111-1111-4111-8111-111111111111");
  assert.equal(second.adoptedGuest, false);
  assert.equal(second.account.ownerId, `account:${second.account.id}`);
  const third = await signInAccount(db, profile({ userId: 43, username: "third" }), null);
  assert.equal(third.account.ownerId, `account:${third.account.id}`);
});

test("sessions sign in only with their token, which the database never stores, and end on sign-out or expiry", async (t) => {
  const db = await database(t);
  const { account } = await signInAccount(db, profile(), null);
  const { token, expiresAt } = await startSession(db, account.id, new Date());
  assert.match(token, /^[\w-]{43}$/);
  assert.ok(expiresAt.getTime() - Date.now() > 29 * 86_400_000);
  assert.equal((await sessionAccount(db, token)).id, account.id);

  const stored = JSON.stringify((await db.query("SELECT * FROM account_sessions")).rows);
  assert.ok(!stored.includes(token), "only the token's hash is stored");
  for (const bad of [null, "", "x", `${token}x`, token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))]) assert.equal(await sessionAccount(db, bad), null);

  await endSession(db, token);
  assert.equal(await sessionAccount(db, token), null);

  const later = await startSession(db, account.id);
  await db.query("UPDATE account_sessions SET expires_at = now() - interval '1 second'");
  assert.equal(await sessionAccount(db, later.token), null, "an expired session signs no one in");
});
