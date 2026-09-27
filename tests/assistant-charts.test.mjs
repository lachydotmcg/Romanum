import test from "node:test";
import assert from "node:assert/strict";
import { FetchedData } from "../src/lib/assistant/fetched-data.ts";
import { buildChart } from "../src/lib/assistant/chart-tool.ts";

const point = (minute, playing, status = "observed") => ({ observedAt: `2026-09-27T00:${String(minute).padStart(2, "0")}:00.000Z`, playing, visits: playing === null ? null : 100, favorites: 0, likes: 3, dislikes: 1, status });
const history = (points) => ({ universeId: 1, available: true, game: { universeId: 1, name: "Test game" }, points });
const args = { type: "line", title: "Recorded players", universeIds: [1], metrics: ["playing"] };

test("line charts require fetched history, not snapshot counts or model-provided values", () => {
  const data = new FetchedData();
  data.add({ games: [{ universeId: 1, name: "Test game", playing: 100 }] });
  const result = buildChart({ ...args, values: [100, 200] }, data);
  assert.equal(result.ok, false);
  assert.match(result.error, /get_game_history/);
});

test("recorded lines retain zero, null gaps, exact timestamps and ordered observations", () => {
  const data = new FetchedData();
  data.add(history([point(10, 50), point(0, 0), point(5, 999, "missed")]));
  const result = buildChart(args, data);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chart.series[0].values, [0, null, 50]);
  assert.deepEqual(result.chart.categories.map((category) => Number(category.key)), [0, 5, 10].map((minute) => Date.parse(point(minute, 0).observedAt)));
  assert.equal(result.chart.kind, "line");
});

test("history survives conversation reconstruction and ratios preserve gaps", () => {
  const data = FetchedData.fromMessages([{ role: "tool", content: JSON.stringify(history([point(0, 10), point(5, null, "unavailable"), point(10, 20)])) }]);
  const result = buildChart({ ...args, metrics: ["likeRatio"] }, data);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chart.series[0].values, [0.75, null, 0.75]);
  assert.equal(result.chart.series[0].format, "percent");
});

test("history rejects unsupported metrics, sparse samples, mismatched universes and bad timestamps", () => {
  const data = new FetchedData();
  data.add(history([point(0, 10), { ...point(5, 30), observedAt: "bad" }]));
  assert.equal(buildChart(args, data).ok, false);
  data.add(history([point(0, 10), point(5, 20)]));
  assert.equal(buildChart({ ...args, metrics: ["maxPlayersPerServer"] }, data).ok, false);
  assert.equal(buildChart({ ...args, universeIds: [1, 2] }, data).ok, false);
  data.add({ ...history([point(0, 10), point(5, 20)]), game: { universeId: 2, name: "Other" } });
  assert.equal(buildChart(args, data).ok, false);
});

test("later empty or unavailable history does not reuse an older successful result", () => {
  for (const replacement of [{ ...history([]), available: false }, history([])]) {
    const data = new FetchedData();
    data.add(history([point(0, 10), point(5, 20)]));
    data.add(replacement);
    assert.equal(buildChart(args, data).ok, false);
  }
});
