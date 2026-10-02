import test from "node:test";
import assert from "node:assert/strict";
import { dailyMetricChange } from "../src/lib/linked-games/changes.ts";

const series = (before, after) => [{ day: "2026-09-29", value: before, status: null }, { day: "2026-09-30", value: after, status: null }];

test("daily changes use real consecutive values, preserve units and never divide by a zero baseline", () => {
  assert.equal(dailyMetricChange(series(0, 12), "count").label, "+12");
  assert.equal(dailyMetricChange(series(14, 12), "robux").label, "−R$2");
  assert.equal(dailyMetricChange(series(7.5, 8), "minutes").label, "+0.5 min");
  assert.equal(dailyMetricChange(series(12, 12), "count").direction, "flat");
});

test("retention differences are percentage points under either existing source scale", () => {
  assert.equal(dailyMetricChange(series(0.30, 0.35), "rate").label, "+5.0 pp");
  assert.equal(dailyMetricChange(series(30, 35), "rate").label, "+5.0 pp");
});

test("missing days, missing values and projected cohorts have no measured delta", () => {
  assert.equal(dailyMetricChange([], "count"), null);
  assert.equal(dailyMetricChange(series(1, 2).slice(1), "count"), null);
  assert.equal(dailyMetricChange([{ day: "2026-09-28", value: 1, status: null }, ...series(1, 2).slice(1)], "count"), null);
  assert.equal(dailyMetricChange(series(NaN, 2), "count"), null);
  assert.equal(dailyMetricChange(series(0.3, 0.35).map((point, index) => index ? { ...point, status: "Projected" } : point), "rate"), null);
});
