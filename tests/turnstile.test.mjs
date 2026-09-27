import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { turnstileConfig, verifyTurnstile, verificationResponse, VerificationError } from "../src/lib/turnstile.ts";
import { GUEST_SECONDS, signGuest, verifiedGuestId } from "../src/lib/guest-token.ts";
import { signAttempt, verifiedAttempt } from "../src/lib/accounts/sign-in-cookie.ts";
import { encodeAttempt, newSignInAttempt } from "../src/lib/accounts/roblox-oauth.ts";

const env = { NODE_ENV: "production", TURNSTILE_SITE_KEY: "real-site", TURNSTILE_SECRET_KEY: "real-secret", TURNSTILE_ALLOWED_HOSTNAMES: "romanum.example" };
const local = { NODE_ENV: "development", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
const request = (token = "valid-token", url = "https://romanum.example/api/credits") => new Request(url, { method: "POST", headers: token === null ? {} : { "x-turnstile-token": token } });
const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const valid = { success: true, hostname: "romanum.example", action: "guest" };

test("Turnstile requires configured keys and an explicit matching production hostname", () => {
  for (const changed of [{ TURNSTILE_SITE_KEY: "" }, { TURNSTILE_SECRET_KEY: "" }, { TURNSTILE_ALLOWED_HOSTNAMES: "" }, { TURNSTILE_ALLOWED_HOSTNAMES: "other.example" }]) {
    assert.equal(turnstileConfig(request().url, { ...env, ...changed }), null);
  }
  assert.equal(turnstileConfig(request().url, env)?.test, false);
});

test("dummy keys only work as a pair on local development hosts", () => {
  assert.equal(turnstileConfig("http://localhost:3000", local)?.test, true);
  assert.equal(turnstileConfig("http://127.0.0.1:3000", local)?.test, true);
  assert.equal(turnstileConfig("https://romanum.example", local), null);
  assert.equal(turnstileConfig("http://localhost:3000", { ...local, NODE_ENV: "production" }), null);
  assert.equal(turnstileConfig("http://localhost:3000", { ...local, TURNSTILE_SECRET_KEY: "real-secret" }), null);
  assert.equal(turnstileConfig("http://localhost:3000", { ...local, TURNSTILE_SITE_KEY: "real-site" }), null);
});

test("missing and oversized tokens never contact Cloudflare", async () => {
  for (const token of [null, "", "x".repeat(2049)]) {
    await assert.rejects(verifyTurnstile(request(token), "guest", { env, fetch: async () => assert.fail("must not fetch") }), VerificationError);
  }
});

test("Siteverify receives the secret server-side and no untrusted forwarded IP", async () => {
  let calls = 0;
  await verifyTurnstile(request(), "guest", { env, fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init.method, "POST");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), { secret: "real-secret", response: "valid-token" });
    return json(valid);
  } });
  assert.equal(calls, 1);
});

test("uses the allowed browser hostname when Next's URL contains its bind address", async () => {
  const proxied = new Request("http://localhost:3000/auth/roblox", { headers: { host: "romanum.example", "x-turnstile-token": "valid-token" } });
  await verifyTurnstile(proxied, "roblox_signin", { env, fetch: async () => json({ ...valid, action: "roblox_signin" }) });
  const wrongHost = new Request(proxied, { headers: { host: "other.example", "x-turnstile-token": "valid-token" } });
  await assert.rejects(verifyTurnstile(wrongHost, "roblox_signin", { env, fetch: async () => assert.fail("must not fetch") }), VerificationError);
});

test("rejects wrong actions, wrong hosts, malformed results and expired/replayed tokens", async () => {
  for (const result of [null, {}, { ...valid, success: "true" }, { ...valid, action: "roblox_signin" }, { ...valid, hostname: "other.example" }, { success: false, "error-codes": ["timeout-or-duplicate"] }]) {
    await assert.rejects(verifyTurnstile(request(), "guest", { env, fetch: async () => json(result) }), VerificationError);
  }
});

test("network, timeout, HTTP and invalid JSON failures fail closed without leaking details", async () => {
  for (const fetch of [async () => { throw new Error("secret token diagnostic"); }, async () => new Response("down", { status: 503 }), async () => new Response("invalid JSON")]) {
    try { await verifyTurnstile(request(), "guest", { env, fetch }); assert.fail("must reject"); }
    catch (error) {
      const response = verificationResponse(error);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /real-secret|valid-token|diagnostic/);
    }
  }
});

test("local dummy Siteverify responses can omit action and hostname but must still succeed", async () => {
  await verifyTurnstile(request("XXXX.DUMMY.TOKEN.XXXX", "http://localhost:3000"), "roblox_signin", { env: local, fetch: async () => json({ success: true, hostname: "dummy-key-pass", action: "" }) });
  await assert.rejects(verifyTurnstile(request("XXXX.DUMMY.TOKEN.XXXX", "http://localhost:3000"), "guest", { env: local, fetch: async () => json({ success: false }) }), VerificationError);
});

test("verification errors expose only the public key and bounded retry information", async () => {
  const response = verificationResponse(new VerificationError("guest", env.TURNSTILE_SITE_KEY));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Verify to continue.", code: "verification_required", action: "guest", siteKey: "real-site" });
  assert.equal(verificationResponse(new Error("ordinary")), null);
});

test("guest proofs reject invented cookies, changed identities, tampering, expiry and different keys", () => {
  const key = randomBytes(32), id = randomUUID(), now = Date.now();
  const signed = signGuest(id, key, now);
  assert.equal(verifiedGuestId(signed, key, now), id);
  for (const value of [undefined, id, signed.replace(id, randomUUID()), signed + ".extra", signed.slice(0, -1) + "!", "x".repeat(200)]) assert.equal(verifiedGuestId(value, key, now), null);
  assert.equal(verifiedGuestId(signed, randomBytes(32), now), null);
  assert.equal(verifiedGuestId(signed, key, now + GUEST_SECONDS * 1000), null);
  assert.equal(verifiedGuestId(signed, key, now - 1000), null);
});

test("OAuth callback requires a signed, recent attempt issued after Turnstile", () => {
  const key = randomBytes(32), now = Date.now(), attempt = newSignInAttempt("/profile");
  const signed = signAttempt(attempt, key, now);
  assert.deepEqual(verifiedAttempt(signed, key, now), attempt);
  assert.equal(verifiedAttempt(encodeAttempt(attempt), key, now), null);
  assert.equal(verifiedAttempt(signed.replace(encodeAttempt(attempt), encodeAttempt(newSignInAttempt("/profile"))), key, now), null);
  assert.equal(verifiedAttempt(signed, randomBytes(32), now), null);
  assert.equal(verifiedAttempt(signed, key, now + 600_000), null);
  assert.equal(verifiedAttempt(signed, key, now - 1000), null);
});
