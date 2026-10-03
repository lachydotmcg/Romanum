import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imageLibraryResponse } from "../src/lib/image-library/http.ts";

let token, database, databaseReads = 0;
globalThis.__librarySessionFixture = {
  cookies: async () => ({ get: () => token ? { value: token } : undefined }),
  database: async () => { databaseReads++; return database; },
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") return { url: "data:text/javascript,export const cookies=globalThis.__librarySessionFixture.cookies;", shortCircuit: true };
    if (specifier === "../accounts/session") return { url: "data:text/javascript,export const SESSION_COOKIE='romanum_session';", shortCircuit: true };
    if (specifier === "../history/database.ts") return { url: "data:text/javascript,export const historyDatabase=globalThis.__librarySessionFixture.database;", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(target)) && existsSync(fileURLToPath(`${target.href}.ts`))) return nextResolve(`${target.href}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { imageLibraryDependencies } = await import("../src/lib/image-library/server.ts");
hooks.deregister();
test.after(() => { delete globalThis.__librarySessionFixture; });
const response = () => imageLibraryResponse(new Request("https://fixture.invalid/api/image-library"), imageLibraryDependencies);

test("real library session adapter distinguishes no session, expired session and failed verification storage", async () => {
  assert.equal((await response()).status, 401);
  assert.equal(databaseReads, 0, "unsigned requests never query session storage");
  token = "a".repeat(43);
  for (const unavailable of [null, { query: async () => { throw new Error("private database token"); } }]) {
    database = unavailable;
    const result = await response();
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await result.json(), { status: "unavailable", error: "Image library unavailable. Try again later." });
  }
  database = { query: async () => ({ rows: [] }) };
  assert.equal((await response()).status, 401, "an actually expired session still requires sign-in");
});
