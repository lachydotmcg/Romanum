import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { importAdReports } from "../src/lib/ad-reports/import.ts";
import { CANONICAL_DAILY_CSV, CANONICAL_DAILY_HEADER } from "../src/lib/ad-reports/types.ts";

const name = "Romanum_Daily_v1_Ads_AllUsers.csv";
const context = { periodStart: "2026-09-03", periodEnd: "2026-09-03", timezone: "UTC", attributionWindow: "7 days", placement: "Sponsored", audience: "All Players", currency: "Ad Credit" };
const row = { date: "2026-09-03", campaignId: "campaign-1", campaignName: "Synthetic", adId: "ad-1", adName: "Synthetic", universeId: "123", objective: "Maximize Plays", adFormat: "Sponsored", impressions: "2000", clicks: "100", plays: "20", spend: "10", paymentType: "Ad Credit" };
const prefix = Buffer.from(CANONICAL_DAILY_CSV + CANONICAL_DAILY_HEADER.map(key => row[key] ?? "").join(",") + "\r\n");
const packed = (bytes = prefix, level = 9) => zipSync({ [name]: bytes }, { level });
const positions = bytes => { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const end = bytes.length - 22; return { view, end, directory: view.getUint32(end + 16, true) }; };
const importZip = bytes => importAdReports({ name: "synthetic.zip", bytes }, context);

test("DEFLATE rejects actual output exceeding a forged small size and CRC prefix", () => {
  const ordinary = positions(packed());
  const bytes = packed(Buffer.concat([prefix, Buffer.alloc(24 * 1024 * 1024, 65)]));
  const { view, directory } = positions(bytes);
  const crc = ordinary.view.getUint32(ordinary.directory + 16, true);
  for (const [offset, value] of [[14, crc], [22, prefix.length], [directory + 16, crc], [directory + 24, prefix.length]]) view.setUint32(offset, value, true);
  assert.ok(bytes.length < 30_000);
  // This formerly returned the valid prefix while silently inflating 24 MiB.
  assert.throws(() => importZip(bytes), /DEFLATE output exceeds declared size/);
});

test("a ZIP64 locator hidden in an entry comment cannot redirect extraction", () => {
  const base = packed(), { directory, end } = positions(base);
  const record = Buffer.alloc(56), hidden = Buffer.from(base.subarray(directory, end));
  record.writeUInt32LE(0x06064b50, 0); record.writeUInt32LE(1, 32); record.writeUInt32LE(directory + record.length, 48);
  hidden.writeUInt32LE(6 * 1024 * 1024, 24);
  const legitimate = Buffer.from(base.subarray(directory, end)); legitimate.writeUInt16LE(20, 32);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeUInt32LE(directory, 8); locator.writeUInt32LE(1, 16);
  const tail = Buffer.from(base.subarray(end)); tail.writeUInt32LE(legitimate.length + locator.length, 12); tail.writeUInt32LE(directory + record.length + hidden.length, 16);
  const bytes = Buffer.concat([base.subarray(0, directory), record, hidden, legitimate, locator, tail]);
  assert.ok(bytes.length < 600);
  assert.throws(() => importZip(bytes), /ZIP64/);
});

test("forged sizes, CRC, local metadata, truncation and compression ratios reject", () => {
  const larger = packed(), a = positions(larger);
  a.view.setUint32(22, prefix.length + 1, true); a.view.setUint32(a.directory + 24, prefix.length + 1, true);
  assert.throws(() => importZip(larger), /expanded-size/);
  const crc = packed(), b = positions(crc), wrong = b.view.getUint32(b.directory + 16, true) ^ 1;
  b.view.setUint32(14, wrong, true); b.view.setUint32(b.directory + 16, wrong, true);
  assert.throws(() => importZip(crc), /checksum/);
  const inconsistent = packed(); positions(inconsistent).view.setUint32(22, prefix.length + 1, true);
  assert.throws(() => importZip(inconsistent), /metadata mismatch/);
  const truncated = packed(), c = positions(truncated), compressed = c.view.getUint32(18, true) - 1;
  c.view.setUint32(18, compressed, true); c.view.setUint32(c.directory + 20, compressed, true);
  assert.throws(() => importZip(truncated), /DEFLATE/);
  assert.throws(() => importZip(packed(Buffer.alloc(300_000, 65))), /compression ratio/);
});

test("ZIP64 extra fields reject and normal stored/compressed archives retain exact CSV", () => {
  const bytes = zipSync({ [name]: prefix }, { extra: { 1: new Uint8Array(8) }, level: 9 });
  assert.throws(() => importZip(bytes), /ZIP64/);
  for (const level of [0, 1, 6, 9]) {
    const report = importZip(packed(prefix, level));
    assert.equal(report.files.length, 1); assert.equal(report.files[0].rows[0].impressions, 2000);
    assert.equal(report.files[0].rows[0].sourceLine, 2);
  }
});
