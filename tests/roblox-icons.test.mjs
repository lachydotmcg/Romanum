import assert from "node:assert/strict";
import test from "node:test";

import { getGameIcons, isRobloxImageUrl } from "../src/lib/roblox-icons.ts";

const ICON_URL = (n) => `https://tr.rbxcdn.com/abc${n}/150x150/Png/GameIcon.png`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Replace global fetch for one test, recording every call and restoring the original afterwards. */
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function universeIdsParam(call) {
  return new URL(call.url).searchParams.get("universeIds");
}

test("isRobloxImageUrl accepts https rbxcdn hosts and subdomains", () => {
  assert.equal(isRobloxImageUrl("https://tr.rbxcdn.com/abc/150x150/Png/GameIcon.png"), true);
  assert.equal(isRobloxImageUrl("https://rbxcdn.com/abc.png"), true);
  assert.equal(isRobloxImageUrl("https://c0.rbxcdn.com/x/y.png"), true);
  assert.equal(isRobloxImageUrl("https://a.b.rbxcdn.com/x.png"), true);
  assert.equal(isRobloxImageUrl("https://tr.rbxcdn.com:443/x.png"), true);
});

test("isRobloxImageUrl rejects non-roblox, unsafe and malformed URLs", () => {
  assert.equal(isRobloxImageUrl("http://tr.rbxcdn.com/x.png"), false);
  assert.equal(isRobloxImageUrl("https://user:pass@tr.rbxcdn.com/x.png"), false);
  assert.equal(isRobloxImageUrl("https://tr.rbxcdn.com:8443/x.png"), false);
  assert.equal(isRobloxImageUrl("https://rbxcdn.com.evil.example/x.png"), false);
  assert.equal(isRobloxImageUrl("https://notrbxcdn.com/x.png"), false);
  assert.equal(isRobloxImageUrl("https://evilrbxcdn.com/x.png"), false);
  assert.equal(isRobloxImageUrl("https://tr.rbxcdn.com/../x.png"), true);
  assert.equal(isRobloxImageUrl("not a url"), false);
  assert.equal(isRobloxImageUrl(""), false);
  assert.equal(isRobloxImageUrl(null), false);
  assert.equal(isRobloxImageUrl(undefined), false);
  assert.equal(isRobloxImageUrl(42), false);
});

test("getGameIcons does not fetch for empty or invalid input", async (t) => {
  const calls = mockFetch(t, () => assert.fail("fetch should not be called"));

  assert.equal((await getGameIcons([])).size, 0);
  assert.equal((await getGameIcons([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])).size, 0);
  assert.equal(calls.length, 0);
});

test("getGameIcons matches shuffled targetIds back to the requested ids", async (t) => {
  const calls = mockFetch(t, () =>
    jsonResponse({
      data: [
        { targetId: 13, state: "Completed", imageUrl: ICON_URL(13) },
        { targetId: 11, state: "Completed", imageUrl: ICON_URL(11) },
        { targetId: 12, state: "Completed", imageUrl: ICON_URL(12) },
      ],
    }),
  );

  const icons = await getGameIcons([11, 12, 13]);

  assert.equal(calls.length, 1);
  assert.equal(universeIdsParam(calls[0]), "11,12,13");
  // Key order follows the (shuffled) response, so compare sorted keys and values per id.
  assert.deepEqual([...icons.keys()].sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(icons.get(11), ICON_URL(11));
  assert.equal(icons.get(12), ICON_URL(12));
  assert.equal(icons.get(13), ICON_URL(13));
});

test("getGameIcons skips unavailable records, bad states and unsafe URLs", async (t) => {
  mockFetch(t, () =>
    jsonResponse({
      data: [
        { targetId: 1, state: "Completed", imageUrl: ICON_URL(1) },
        { targetId: 2, state: "Pending", imageUrl: ICON_URL(2) },
        { targetId: 3, state: "Blocked", imageUrl: ICON_URL(3) },
        { targetId: 4, state: "Unavailable", imageUrl: "" },
        { targetId: 5, state: "Completed", imageUrl: "http://tr.rbxcdn.com/insecure.png" },
        { targetId: 6, state: "Completed", imageUrl: "https://user:pass@tr.rbxcdn.com/creds.png" },
        { targetId: 7, state: "Completed", imageUrl: "https://tr.rbxcdn.com:8443/port.png" },
        { targetId: 8, state: "Completed", imageUrl: "https://evil.example/redirect.png" },
        { targetId: 9, state: "Completed", imageUrl: "https://notrbxcdn.com/fake.png" },
        { targetId: 10, state: "Completed" },
        null,
        "nonsense",
      ],
    }),
  );

  const icons = await getGameIcons([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  assert.deepEqual([...icons.keys()], [1]);
  assert.equal(icons.get(1), ICON_URL(1));
});

test("getGameIcons ignores records for universes that were not requested", async (t) => {
  mockFetch(t, () =>
    jsonResponse({
      data: [
        { targetId: 1, state: "Completed", imageUrl: ICON_URL(1) },
        { targetId: 999, state: "Completed", imageUrl: ICON_URL(999) },
      ],
    }),
  );

  const icons = await getGameIcons([1]);

  assert.deepEqual([...icons.keys()], [1]);
});

test("getGameIcons dedupes and sorts ids into one stable request", async (t) => {
  const calls = mockFetch(t, () =>
    jsonResponse({ data: [{ targetId: 3, state: "Completed", imageUrl: ICON_URL(3) }] }),
  );

  const icons = await getGameIcons([5, 3, 5, 1, 3]);

  assert.equal(calls.length, 1);
  assert.equal(universeIdsParam(calls[0]), "1,3,5");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/games/icons");
  assert.equal(url.searchParams.get("size"), "150x150");
  assert.equal(url.searchParams.get("format"), "Png");
  assert.equal(url.searchParams.get("isCircular"), "false");
  assert.equal(icons.get(3), ICON_URL(3));
});

test("getGameIcons batches ids 100 at a time in sorted order", async (t) => {
  const ids = Array.from({ length: 250 }, (_, i) => 250 - i);
  const calls = mockFetch(t, () => jsonResponse({ data: [] }));

  await getGameIcons(ids);

  assert.equal(calls.length, 3);
  const batches = calls.map((call) => universeIdsParam(call).split(",").map(Number));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 50],
  );
  assert.deepEqual(
    batches.flat(),
    [...ids].sort((a, b) => a - b),
  );
  assert.equal(new URL(calls[0].url).searchParams.get("size"), "150x150");
});

test("large artwork uses Roblox's 512 square size without changing the default icon request", async (t) => {
  const calls = mockFetch(t, () => jsonResponse({ data: [{ targetId: 1, state: "Completed", imageUrl: ICON_URL(1) }] }));
  assert.equal((await getGameIcons([1], "512x512")).get(1), ICON_URL(1));
  await getGameIcons([1]);
  assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get("size")), ["512x512", "150x150"]);
});

test("getGameIcons returns a partial map when one batch fails", async (t) => {
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);
  mockFetch(t, (call) => {
    const batch = universeIdsParam(call).split(",").map(Number);
    if (batch.length === 100) {
      return jsonResponse({
        data: batch.map((id) => ({ targetId: id, state: "Completed", imageUrl: ICON_URL(id) })),
      });
    }
    return jsonResponse({ error: "boom" }, 500);
  });

  const icons = await getGameIcons(ids);

  assert.equal(icons.size, 100);
  assert.equal(icons.get(1), ICON_URL(1));
  assert.equal(icons.get(100), ICON_URL(100));
  assert.equal(icons.get(101), undefined);
});

test("getGameIcons survives thrown, non-array and malformed responses", async (t) => {
  const responses = [
    () => {
      throw new Error("network down");
    },
    () => jsonResponse({ data: "not-an-array" }),
    () => new Response("{ not json", { status: 200 }),
    () => jsonResponse({ data: [{ targetId: 4, state: "Completed", imageUrl: ICON_URL(4) }] }),
  ];
  mockFetch(t, (_call, index) => responses[index]());

  const a = await getGameIcons([1]);
  const b = await getGameIcons([2]);
  const c = await getGameIcons([3]);
  const d = await getGameIcons([4]);

  assert.equal(a.size, 0);
  assert.equal(b.size, 0);
  assert.equal(c.size, 0);
  assert.equal(d.size, 1);
  assert.equal(d.get(4), ICON_URL(4));
});
