import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const id = "b81d572e-bdfc-4564-84a1-e5bd7fb18465";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
let owner = "fixture-owner", accountReads = 0;
const image = { id, width: 1, height: 1, title: "Fixture image" };
globalThis.__libraryRouteDependencies = {
  account: async () => { accountReads++; return owner ? { ownerId: owner } : null; },
  origin: () => "https://fixture.invalid",
  storage: async () => ({
    list: async (scope, query) => { assert.equal(scope, "fixture-owner"); assert.equal(query.limit, 12); return { images: [image], nextCursor: null }; },
    detail: async (scope, assetId) => scope === "fixture-owner" && assetId === id ? image : null,
    file: async (scope, assetId) => { assert.equal(scope, "fixture-owner"); assert.equal(assetId, id); return { status: "ready", bytes: png, mimeType: "image/png" }; },
  }),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/image-library/server") return { url: "data:text/javascript,export const imageLibraryDependencies=globalThis.__libraryRouteDependencies;", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const target = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url);
      if (existsSync(fileURLToPath(target))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const list = await import("../src/app/api/image-library/route.ts");
const detail = await import("../src/app/api/image-library/[id]/route.ts");
const file = await import("../src/app/api/image-library/[id]/file/route.ts");
hooks.deregister();
test.after(() => { delete globalThis.__libraryRouteDependencies; });
const request = () => new Request("https://fixture.invalid/api/image-library");
const params = assetId => ({ params: Promise.resolve({ id: assetId }) });

test("actual route exports preserve dynamic owner-gated metadata and file behavior", async () => {
  for (const route of [list, detail, file]) { assert.equal(route.runtime, "nodejs"); assert.equal(route.dynamic, "force-dynamic"); }
  assert.equal((await list.GET(request())).status, 200);
  assert.equal((await detail.GET(request(), params(id))).status, 200);
  assert.deepEqual(Buffer.from(await (await file.GET(request(), params(id))).arrayBuffer()), png);
  assert.equal(accountReads, 3);
  owner = "other-owner";
  assert.equal((await detail.GET(request(), params(id))).status, 404);
  assert.equal((await file.GET(request(), params(id))).status, 404);
  owner = null;
  assert.equal((await list.GET(request())).status, 401);
  assert.equal((await detail.GET(request(), params(id))).status, 401);
  assert.equal((await file.GET(request(), params(id))).status, 401);
});
