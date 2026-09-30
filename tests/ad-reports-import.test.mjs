import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { AD_REPORT_LIMITS, importAdReports, parseAdCsv, validateAdReportBundle } from "../src/lib/ad-reports/import.ts";
import { CANONICAL_DAILY_HEADER, CANONICAL_DAILY_CSV } from "../src/lib/ad-reports/types.ts";
import { summarizeAdReports, compareAdReports } from "../src/lib/ad-reports/compare.ts";

// Synthetic unit inputs below are parser tests only, never a customer report or product seed.
const encode = (text) => new TextEncoder().encode(text);
const context = { periodStart: "2026-09-03", periodEnd: "2026-09-03", timezone: "UTC", attributionWindow: "7 days", placement: "Sponsored", audience: "All Players", currency: "Ad Credit" };
const selection = { grain: "daily", cohort: "AllUsers", entityType: "ad" };
const dailyName = "Romanum_Daily_v1_Ads_AllUsers.csv";
const values = (extra = {}) => ({ date: "2026-09-03", campaignId: "campaign-1", campaignName: "Test campaign", adId: "ad-1", adName: "Test ad", universeId: "123", objective: "Maximize Plays", adFormat: "Sponsored", impressions: "2000", clicks: "100", plays: "20", spend: "10", paymentType: "Ad Credit", reportedCtr: "0.049", reportedPlayRate: "0.011", reportedCpc: "0.09", reportedCpp: "0.49", ...extra });
const csv = (rows) => CANONICAL_DAILY_CSV + rows.map((row) => CANONICAL_DAILY_HEADER.map((key) => { const value = row[key] ?? ""; return /[,"\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }).join(",")).join("\r\n") + "\r\n";
const imported = (rows, ctx = context) => importAdReports({ name: dailyName, bytes: encode(csv(rows)) }, ctx);

test("CSV quoting, BOM, physical source lines and malformed input", () => {
  const rows = parseAdCsv(encode('\uFEFFa,b\r\n"one, two","multi\nline"\r\n"escaped ""quote""",three\r\n'));
  assert.deepEqual(rows, [{ values: ["a", "b"], sourceLine: 1 }, { values: ["one, two", "multi\nline"], sourceLine: 2 }, { values: ['escaped "quote"', "three"], sourceLine: 4 }]);
  for (const text of ['a\n"unfinished', 'a\n"closed"extra', 'a\nqu"ote']) assert.throws(() => parseAdCsv(encode(text)), /quote|Unterminated/i);
  assert.throws(() => parseAdCsv(new Uint8Array([0xff])), /UTF-8/);
  assert.throws(() => parseAdCsv(encode("a\0b")), /NUL/);
});

test("canonical daily separates reported/calculated metrics and preserves blank, dash and zero", () => {
  const report = imported([values({ clicks: "0", plays: "-", spend: "", reportedCpc: "0" })]);
  const row = report.files[0].rows[0];
  assert.equal(row.clicks, 0); assert.equal(row.plays, null); assert.equal(row.spend, null);
  assert.equal(row.calculated.ctr, 0); assert.equal(row.calculated.cpp, null); assert.equal(row.reported.cpc, 0);
  assert.equal(row.reported.ctr, 0.049); assert.equal(row.sourceLine, 2);
  assert.equal(report.format, "romanum-daily-v1");
  assert.deepEqual(imported([values()]), imported([values()]));
  const sorted = JSON.parse(JSON.stringify(report), (key, value) => value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  assert.deepEqual(validateAdReportBundle(sorted), report);
});

test("strict schema, dates, IDs, source numeric cells and limits are enforced", () => {
  assert.throws(() => importAdReports({ name: "daily.csv", bytes: encode(csv([values()])) }, context), /unsupported/);
  assert.throws(() => imported([values({ date: "2026-09-04" })]), /period/);
  assert.throws(() => imported([values({ date: "2026-02-30" })]), /date/i);
  for (const extra of [{ clicks: "-1" }, { clicks: "1.5" }, { spend: "$5" }, { impressions: "1,23" }, { adId: "" }]) assert.throws(() => imported([values(extra)]));
  assert.throws(() => importAdReports({ name: dailyName, bytes: encode("date,impressions\n2026-09-03,1") }, context), /header/);
  assert.throws(() => imported([values()], { ...context, timezone: "Invalid/Zone" }), /timezone/i);
  assert.throws(() => importAdReports({ name: dailyName, bytes: new Uint8Array(AD_REPORT_LIMITS.uploadBytes + 1) }, context), /size/);
  assert.throws(() => parseAdCsv(encode(`a\n${"x".repeat(AD_REPORT_LIMITS.cellChars + 1)}`)), /cell/);
});

test("exact duplicate observations deduplicate but conflicts reject", () => {
  const report = imported([values(), values()]);
  assert.equal(report.files[0].rows.length, 1);
  assert.ok(report.warnings.some((warning) => warning.includes("Duplicate observation skipped")));
  assert.throws(() => imported([values(), values({ clicks: "101" })]), /Conflicting duplicate/);
  const changed = structuredClone(report); changed.files[0].rows[0].calculated.ctr = 1;
  assert.throws(() => validateAdReportBundle(changed), /Calculated/);
});

test("ZIP rejects unsafe names, non-CSV, bombs, duplicate entries and checksum damage", () => {
  const zip = (files) => ({ name: "reports.zip", bytes: zipSync(files) });
  for (const name of ["../a.csv", "/a.csv", "a\\b.csv", "C:a.csv", "unexpected.txt"]) assert.throws(() => importAdReports(zip({ [name]: encode("a") }), context), /Unsafe|CSV/);
  assert.throws(() => importAdReports(zip({ [dailyName]: encode("x".repeat(300000)) }), context), /compression ratio/);
  const bytes = zipSync({ "a.csv": encode("a"), "b.csv": encode("b") }, { level: 0 });
  const needle = encode("b.csv");
  for (let i = 0; i < bytes.length - needle.length; i++) if (needle.every((byte, j) => bytes[i + j] === byte)) bytes[i] = 97;
  assert.throws(() => importAdReports({ name: "duplicate.zip", bytes }, context), /Duplicate ZIP/);
  const damaged = zipSync({ [dailyName]: encode(csv([values()])) }, { level: 0 });
  damaged[30 + dailyName.length + 10] ^= 1;
  assert.throws(() => importAdReports({ name: "damaged.zip", bytes: damaged }, context), /checksum/);
  const report = importAdReports(zip({ [dailyName]: encode(csv([values()])) }), context);
  assert.equal(report.files[0].rows.length, 1);
  assert.throws(() => importAdReports({ name: "bad.zip", bytes: encode("bad") }, context), /ZIP/);
});

test("selection prevents summing grains/cohorts/entities; unknown values do not become zeros", () => {
  const report = imported([values(), values({ adId: "ad-2", clicks: "", plays: "0" })]);
  const summary = summarizeAdReports(report, selection);
  assert.equal(summary.impressions, 4000); assert.equal(summary.clicks, null); assert.equal(summary.calculated.ctr, null); assert.equal(summary.missing.clicks, 1);
  const empty = summarizeAdReports(report, { ...selection, cohort: "7DResurrected" });
  assert.equal(empty.rowCount, 0); assert.equal(empty.impressions, null);
  assert.throws(() => summarizeAdReports(report, { grain: "daily" }), /explicit/);
  assert.throws(() => summarizeAdReports(report, { ...selection, grain: "aggregate", dateStart: "2026-09-03" }), /Aggregate/);
  const mixed = imported([values(), values({ adId: "ad-2", paymentType: "USD" })]);
  assert.equal(summarizeAdReports(mixed, selection).spend, null);
});

test("same-report ad comparison requires identical context and uses paid CTR", () => {
  const report = imported([values(), values({ adId: "ad-2", clicks: "200", plays: "40" })]);
  const options = { left: { ...selection, adId: "ad-1" }, right: { ...selection, adId: "ad-2" } };
  const comparison = compareAdReports(report, report, options);
  assert.equal(comparison.comparable, true); assert.equal(comparison.winner, "right");
  assert.equal(comparison.delta.ctr, 0.05); assert.equal(comparison.left.calculated.ctr, 0.05);
  for (const [key, value] of [["timezone", "America/New_York"], ["attributionWindow", null], ["placement", "Home"], ["audience", "Different"], ["periodEnd", "2026-09-04"]]) {
    const changed = structuredClone(report); changed.context[key] = value;
    assert.equal(compareAdReports(report, changed, options).comparable, false);
  }
  const different = imported([values(), values({ adId: "ad-2", objective: "Unspecified" })]);
  assert.equal(compareAdReports(different, different, options).winner, null);
  const small = imported([values({ clicks: "2", plays: "0" }), values({ adId: "ad-2", clicks: "3", plays: "1" })]);
  assert.equal(compareAdReports(small, small, options).winner, null);
  const unknownCurrency = imported([values(), values({ adId: "ad-2" })], { ...context, currency: null });
  const cost = compareAdReports(unknownCurrency, unknownCurrency, { ...options, metric: "cpc" });
  assert.equal(cost.comparable, false); assert.equal(cost.delta.cpc, null);
  assert.equal(compareAdReports(unknownCurrency, unknownCurrency, options).delta.cpc, null);
});

test("incomplete daily dates and per-entity coverage remain missing", () => {
  const report = imported([values(), values({ date: "2026-09-04", adId: "ad-2" })], { ...context, periodEnd: "2026-09-04" });
  const summary = summarizeAdReports(report, selection);
  assert.ok(summary.warnings.some((warning) => warning.includes("at least one selected entity")));
  assert.equal(compareAdReports(report, report, { left: selection, right: selection }).winner, null);
});

// Owner-provided private fixture is external to the repo. Set env to run it locally.
test("real supplied Roblox aggregate ZIP byte identity and domain regressions", { skip: !process.env.ROMANUM_ADS_FIXTURE }, async () => {
  assert.ok(process.env.ROMANUM_ADS_EXPECTATIONS, "Set ROMANUM_ADS_EXPECTATIONS to the private local golden verification JSON.");
  const expected = JSON.parse(await readFile(process.env.ROMANUM_ADS_EXPECTATIONS, "utf8"));
  const bytes = new Uint8Array(await readFile(process.env.ROMANUM_ADS_FIXTURE));
  const report = importAdReports({ name: expected.fileName, bytes }, { ...context, periodStart: null, periodEnd: null, timezone: null, attributionWindow: null, placement: null, audience: null, currency: null });
  assert.equal(report.sha256, expected.sha256);
  assert.equal(report.files.length, expected.files); assert.equal(report.format, "roblox-aggregate-v1");
  assert.equal(report.context.periodStart, expected.periodStart); assert.equal(report.context.periodEnd, expected.periodEnd);
  assert.equal(report.files.filter((file) => file.rows.length === 0).length, expected.emptyFiles);
  const campaigns = report.files.find((file) => file.cohort === "AllUsers" && file.entityType === "campaign");
  const first = campaigns.rows.find((row) => row.campaignId === expected.primary.campaignId);
  assert.equal(first.impressions, expected.primary.impressions); assert.equal(first.clicks, expected.primary.clicks); assert.equal(first.plays, expected.primary.plays);
  assert.equal(first.reported.ctr, expected.primary.reportedCtr); assert.equal(first.calculated.ctr, expected.primary.clicks / expected.primary.impressions);
  assert.equal(first.raw["Start Date"], expected.primary.startDate); assert.equal(first.date, null);
  const missing = campaigns.rows.find((row) => row.campaignId === expected.missing.campaignId);
  assert.equal(missing.clicks, null); assert.equal(missing.plays, null); assert.equal(missing.spend, expected.missing.spend);
  const adSummary = summarizeAdReports(report, { grain: "aggregate", entityType: "ad", cohort: "AllUsers", campaignId: missing.campaignId });
  assert.equal(adSummary.clicks, expected.missing.adClicks); assert.equal(adSummary.plays, expected.missing.adPlays);
  assert.equal(report.context.currency, null); assert.equal(first.paymentType, "Ad Credit");
  assert.ok(report.warnings.some((warning) => warning.includes("Plays exceed clicks")));
  const onlyNewUsers = report.files.find((file) => file.cohort === "NewUsers" && file.entityType === "campaign");
  assert.equal(Object.hasOwn(onlyNewUsers.rows[0].raw, "USD Revenue"), false);
  const aggregateMissing = summarizeAdReports(report, { grain: "aggregate", entityType: "campaign", cohort: "AllUsers" });
  assert.equal(aggregateMissing.clicks, null);
});
