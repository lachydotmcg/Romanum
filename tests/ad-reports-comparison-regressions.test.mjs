import test from "node:test";
import assert from "node:assert/strict";
import { compareAdReports, summarizeAdReports } from "../src/lib/ad-reports/compare.ts";

// Comparison-only synthetic test observations; no customer data or application seeds.
const selection = { grain: "daily", entityType: "ad", cohort: "AllUsers" };
const options = { left: selection, right: selection };
const day = "2026-09-03";
function observation(extra = {}) {
  const row = { sourceLine: 2, date: day, campaignId: "test-campaign", campaignName: "Test", adId: "test-ad", adName: "Test", impressions: 2000, clicks: 100, plays: 20, spend: 10, paymentType: "Ad Credit", reported: { ctr: null, playRate: null, cpc: null, cpp: null }, raw: { universeId: "123", objective: "Maximize Plays", adFormat: "Sponsored" }, ...extra };
  return { ...row, calculated: { ctr: row.clicks / row.impressions, playsPerImpression: row.plays / row.impressions, cpc: row.spend / row.clicks, cpp: row.spend / row.plays } };
}
function report({ context = {}, rows = [observation()], grain = "daily" } = {}) {
  return { version: 1, format: grain === "daily" ? "romanum-daily-v1" : "roblox-aggregate-v1", sha256: "0".repeat(64), context: { periodStart: day, periodEnd: day, timezone: "UTC", attributionWindow: "7 days", placement: "Sponsored", audience: "All Players", currency: "Ad Credit", ...context }, files: [{ name: "test.csv", sha256: "0".repeat(64), grain, entityType: "ad", cohort: "AllUsers", rows }], warnings: [] };
}

test("CTR comparison only emits CPC/CPP deltas for matching known currency and payment method", () => {
  const left = report();
  const matching = report({ rows: [observation({ clicks: 200, plays: 40, spend: 30 })] });
  const allowed = compareAdReports(left, matching, options);
  assert.equal(allowed.comparable, true);
  assert.equal(allowed.delta.ctr, 0.05);
  assert.ok(Math.abs(allowed.delta.cpc - 0.05) < 1e-12);
  assert.equal(allowed.delta.cpp, 0.25);

  const incompatible = [
    report({ rows: [observation({ paymentType: "Debit Card" })] }),
    report({ rows: [observation({ paymentType: null })] }),
    report({ rows: [observation({ paymentType: "Unspecified" })] }),
    report({ rows: [observation({ paymentType: "" })] }),
    report({ rows: [observation(), observation({ adId: "test-ad-2", paymentType: "Debit Card" })] }),
    report({ context: { currency: null } }),
    report({ context: { currency: "USD" } }),
  ];
  for (const right of incompatible) {
    const result = compareAdReports(left, right, options);
    assert.equal(result.comparable, true);
    assert.notEqual(result.delta.ctr, null);
    assert.equal(result.delta.cpc, null);
    assert.equal(result.delta.cpp, null);
    assert.ok(result.warnings.some((warning) => warning.startsWith("Cost deltas are unavailable")));
  }
  for (const paymentType of [null, "Unspecified"]) {
    const unknown = report({ rows: [observation({ paymentType })] });
    const result = compareAdReports(unknown, unknown, options);
    assert.equal(result.delta.cpc, null);
    assert.equal(result.delta.cpp, null);
  }
  const unknownCurrency = report({ context: { currency: null } });
  assert.equal(compareAdReports(unknownCurrency, unknownCurrency, options).delta.cpc, null);
});

test("direct CPC/CPP comparisons retain incompatibility reasons for missing or conflicting units", () => {
  const left = report();
  for (const metric of ["cpc", "cpp"]) {
    for (const right of [report({ rows: [observation({ paymentType: "Debit Card" })] }), report({ rows: [observation({ paymentType: null })] }), report({ rows: [observation({ paymentType: "Unspecified" })] }), report({ rows: [observation(), observation({ adId: "test-ad-2", paymentType: "Debit Card" })] })]) {
      const result = compareAdReports(left, right, { ...options, metric });
      assert.equal(result.comparable, false);
      assert.equal(result.winner, null);
      assert.ok(result.reasons.some((reason) => reason.includes("same single known Payment Method")));
      assert.equal(result.delta[metric], null);
    }
    for (const currency of [null, "USD"]) {
      const result = compareAdReports(left, report({ context: { currency } }), { ...options, metric });
      assert.equal(result.comparable, false);
      assert.ok(result.reasons.some((reason) => reason.includes("same known currency")));
    }
  }
});

test("daily comparisons use equal selected windows inside different export periods", () => {
  const left = report({ context: { periodStart: "2026-09-01", periodEnd: day } });
  const right = report({ context: { periodStart: day, periodEnd: "2026-09-05" }, rows: [observation({ clicks: 200, plays: 40 })] });
  const narrow = { ...selection, dateStart: day, dateEnd: day };
  const result = compareAdReports(left, right, { left: narrow, right: narrow });
  assert.equal(result.comparable, true);
  assert.equal(result.winner, "right");
  assert.equal(result.left.rowCount, 1);
  assert.equal(result.right.rowCount, 1);
  assert.equal(result.warnings.some((warning) => warning.startsWith("Daily coverage is incomplete")), false);
  const implicitEnds = compareAdReports(left, right, { left: { ...selection, dateStart: day }, right: { ...selection, dateEnd: day } });
  assert.equal(implicitEnds.comparable, true);
});

test("identical complete daily periods compare; distinct selected windows do not", () => {
  const rows = [observation({ date: "2026-09-01" }), observation({ date: "2026-09-02" }), observation()];
  const left = report({ context: { periodStart: "2026-09-01" }, rows });
  const right = report({ context: { periodStart: "2026-09-01" }, rows });
  assert.equal(compareAdReports(left, right, options).comparable, true);
  const result = compareAdReports(left, right, { left: { ...selection, dateStart: day, dateEnd: day }, right: { ...selection, dateStart: "2026-09-02", dateEnd: "2026-09-02" } });
  assert.equal(result.comparable, false);
  assert.ok(result.reasons.includes("Selected reporting periods differ."));
});

test("daily selections outside their export bounds reject rather than silently clip", () => {
  const bounded = report();
  for (const extra of [{ dateStart: "2026-09-02" }, { dateEnd: "2026-09-04" }, { dateStart: "2026-09-04" }, { dateEnd: "2026-09-02" }, { dateStart: "2026-09-01", dateEnd: "2026-09-05" }]) {
    assert.throws(() => summarizeAdReports(bounded, { ...selection, ...extra }), /outside the report period/);
    assert.throws(() => compareAdReports(bounded, bounded, { left: { ...selection, ...extra }, right: selection }), /outside the report period/);
  }
  const unknown = report({ context: { periodStart: null } });
  assert.throws(() => summarizeAdReports(unknown, { ...selection, dateStart: day }), /declared report period/);
  assert.equal(compareAdReports(unknown, unknown, options).comparable, false);
});

test("incomplete selected daily coverage blocks comparison even when export windows differ", () => {
  const left = report({ context: { periodStart: "2026-09-01", periodEnd: "2026-09-04" } });
  const right = report({ context: { periodStart: day, periodEnd: "2026-09-05" }, rows: [observation(), observation({ date: "2026-09-04" })] });
  const selected = { ...selection, dateStart: day, dateEnd: "2026-09-04" };
  const result = compareAdReports(left, right, { left: selected, right: selected });
  assert.equal(result.comparable, false);
  assert.equal(result.winner, null);
  assert.ok(result.reasons.some((reason) => reason.startsWith("Daily date coverage is incomplete")));
});

test("aggregate comparisons still require equal full report windows and disallow daily slicing", () => {
  const aggregate = { ...selection, grain: "aggregate" };
  const left = report({ grain: "aggregate", context: { periodStart: "2026-09-01" }, rows: [observation({ date: null })] });
  const right = report({ grain: "aggregate", context: { periodEnd: "2026-09-05" }, rows: [observation({ date: null })] });
  const result = compareAdReports(left, right, { left: aggregate, right: aggregate });
  assert.equal(result.comparable, false);
  assert.ok(result.reasons.includes("Selected reporting periods differ."));
  assert.throws(() => compareAdReports(left, right, { left: { ...aggregate, dateStart: day, dateEnd: day }, right: aggregate }), /Aggregate reports/);
});
