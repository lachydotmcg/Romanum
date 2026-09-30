import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { zipSync } from "fflate";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject, updateProject } from "../src/lib/projects/store.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import { CANONICAL_DAILY_HEADER, importAdReports } from "../src/lib/ad-reports/import.ts";
import { AdReportError, MAX_PROJECT_REPORTS, MAX_PROJECT_REPORT_BYTES, MAX_OWNER_REPORT_BYTES, importAdReport, readAdReports, readAdReportSettings, readAdReportsForAi, setAdReportConsent, linkAdReportCreative, saveAdObservation, deleteAdReport } from "../src/lib/ad-reports/store.ts";

const ownerId = "owner:ads", otherOwner = "owner:ads-other";
const context = { periodStart: "2026-01-01", periodEnd: "2026-01-02", timezone: "UTC", attributionWindow: "7 days", placement: "Sponsored", audience: "All", currency: "Ad Credit" };
const csv = (adId = "ad-1") => {
  const values = { date: "2026-01-01", campaignId: "campaign-1", campaignName: "Invented campaign", adId, adName: "Invented ad", universeId: "999", objective: "Plays", adFormat: "Image", impressions: "1000", clicks: "50", plays: "10", spend: "20", paymentType: "Ad Credit", reportedCtr: "0.05", reportedPlayRate: "0.01", reportedCpc: "0.4", reportedCpp: "2" };
  return Buffer.from(`${CANONICAL_DAILY_HEADER.join(",")}\n${CANONICAL_DAILY_HEADER.map(key => values[key] ?? "").join(",")}\n`);
};
const bundle = (adId) => importAdReports({ name: "Romanum_Daily_v1_Ads_AllUsers.csv", bytes: csv(adId) }, context);
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof AdReportError && error.code === code);
async function database(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db); return db;
}
const project = (db, owner = ownerId) => createProject(db, { ownerId: owner, name: "Invented ads", context: { game: "Test game" } });
const asset = async (db, owner, projectId) => {
  const id = randomUUID(); await db.query("INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,'generated',$4,'image/png',1,1,$5,'{}')", [id, owner, projectId, Buffer.alloc(45), "a".repeat(64)]); return id;
};
const add = (db, projectId, adId) => importAdReport(db, { ownerId, projectId, bundle: bundle(adId) });

test("reports persist source provenance/context, deduplicate content and isolate owners", async t => {
  const db = await database(t), own = await project(db), other = await project(db, otherOwner);
  const result = await add(db, own.id); assert.equal(result.duplicate, false);
  const again = await add(db, own.id);
  assert.equal(again.duplicate, true); assert.equal(again.report.id, result.report.id);
  const read = await readAdReports(db, ownerId, own.id);
  assert.deepEqual(read.reports[0].bundle, result.report.bundle);
  assert.equal(read.reports[0].bundle.files[0].rows[0].sourceLine, 2);
  assert.match(read.reports[0].bundle.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(read.settings, { aiAnalysis: false, platformImprovement: false, consentVersion: 0 });
  assert.deepEqual(await readAdReportSettings(db, ownerId, own.id), read.settings);
  assert.equal(await readAdReportsForAi(db, ownerId, own.id), null);
  await rejects(readAdReports(db, otherOwner, own.id), "not_found");
  await rejects(importAdReport(db, { ownerId, projectId: other.id, bundle: bundle() }), "not_found");
  await rejects(deleteAdReport(db, { ownerId: otherOwner, projectId: own.id, reportId: result.report.id }), "not_found");
});

test("logical fingerprints deduplicate repacked ZIPs/order but keep explicit contextual interpretations", async t => {
  const db = await database(t), own = await project(db);
  const allName = "Romanum_Daily_v1_Ads_AllUsers.csv", newName = "Romanum_Daily_v1_Ads_NewUsers.csv";
  const firstZip = zipSync({ [allName]: [csv(), { mtime: new Date("2026-01-01T00:00:00Z") }], [newName]: csv() }, { level: 0 });
  const repackedZip = zipSync({ [newName]: csv(), [allName]: [csv(), { mtime: new Date("2026-02-01T00:00:00Z") }] }, { level: 6 });
  const firstBundle = importAdReports({ name: "first.zip", bytes: firstZip }, context);
  const repackedBundle = importAdReports({ name: "repacked.zip", bytes: repackedZip }, context);
  assert.notEqual(firstBundle.sha256, repackedBundle.sha256);
  const first = await importAdReport(db, { ownerId, projectId: own.id, bundle: firstBundle });
  const duplicate = await importAdReport(db, { ownerId, projectId: own.id, bundle: { ...repackedBundle, files: [...repackedBundle.files].reverse() } });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.report.id, first.report.id);
  assert.equal(duplicate.report.bundle.sha256, firstBundle.sha256);
  assert.notEqual(first.report.contentFingerprint, firstBundle.sha256);
  const changedContext = { ...context, attributionWindow: "1 day", audience: "Declared different audience" };
  const interpretation = await importAdReport(db, { ownerId, projectId: own.id, bundle: importAdReports({ name: "repacked.zip", bytes: repackedZip }, changedContext) });
  assert.equal(interpretation.duplicate, false); assert.notEqual(interpretation.report.id, first.report.id);
  assert.notEqual(interpretation.report.contentFingerprint, first.report.contentFingerprint);
  assert.deepEqual(interpretation.report.context, changedContext);
  assert.deepEqual((await readAdReports(db, ownerId, own.id)).reports.find(report => report.id === first.report.id).context, context);
  const normalizedDuplicate = await importAdReport(db, { ownerId, projectId: own.id, bundle: { ...interpretation.report.bundle, context: { ...changedContext, audience: `  ${changedContext.audience}  ` } } });
  assert.equal(normalizedDuplicate.duplicate, true);
  // Same CSV bytes with different declared cohort are separate source identities.
  const all = await add(db, own.id);
  const newUsers = await importAdReport(db, { ownerId, projectId: own.id, bundle: importAdReports({ name: newName, bytes: csv() }, context) });
  assert.equal(newUsers.duplicate, false); assert.notEqual(newUsers.report.contentFingerprint, all.report.contentFingerprint);
  const aggregate = await importAdReport(db, { ownerId, projectId: own.id, bundle: { ...bundle(), format: "roblox-aggregate-v1", files: bundle().files.map(file => ({ ...file, grain: "aggregate", rows: file.rows.map(row => ({ ...row, date: null })) })) } });
  const campaign = await importAdReport(db, { ownerId, projectId: own.id, bundle: { ...bundle(), files: bundle().files.map(file => ({ ...file, entityType: "campaign", rows: file.rows.map(row => ({ ...row, adId: null, adName: null })) })) } });
  assert.equal(aggregate.duplicate, false); assert.equal(campaign.duplicate, false);
  assert.notEqual(aggregate.report.contentFingerprint, all.report.contentFingerprint);
  assert.notEqual(campaign.report.contentFingerprint, all.report.contentFingerprint);
});

test("independent consent is versioned/audited, stale requests conflict, revoke blocks AI", async t => {
  const db = await database(t), own = await project(db); await add(db, own.id);
  const allow = await setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: true, consentVersion: 0 });
  assert.equal(allow.consentVersion, 1); assert.ok(await readAdReportsForAi(db, ownerId, own.id, 1));
  assert.equal(await readAdReportsForAi(db, ownerId, own.id, 0), null);
  await rejects(setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: false, consentVersion: 0 }), "conflict");
  assert.deepEqual(await setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: true, consentVersion: 1 }), allow);
  const revoke = await setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: false, consentVersion: 1 });
  assert.equal(revoke.consentVersion, 2); assert.equal(await readAdReportsForAi(db, ownerId, own.id, 1), null);
  assert.deepEqual((await db.query("SELECT ai_analysis,consent_version FROM ad_report_consents ORDER BY consent_version")).rows, [{ ai_analysis: true, consent_version: 1 }, { ai_analysis: false, consent_version: 2 }]);
  await assert.rejects(db.query("UPDATE ad_report_consents SET ai_analysis=true"), /immutable/);
  await rejects(setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: true, consentVersion: 2, platformImprovement: true }), "invalid_input");
});

test("creative links are explicit and scoped; observations are immutable citations with supersession", async t => {
  const db = await database(t), own = await project(db), other = await project(db, otherOwner), otherProject = await project(db);
  const { report } = await add(db, own.id), { report: later } = await add(db, own.id, "ad-2");
  const creativeId = await asset(db, ownerId, own.id), outsider = await asset(db, otherOwner, other.id), elsewhere = await asset(db, ownerId, otherProject.id);
  assert.deepEqual((await readAdReports(db, ownerId, own.id)).links, []);
  const link = await linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId });
  assert.equal((await linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId })).id, link.id);
  const replacement = await asset(db, ownerId, own.id);
  await linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId: replacement });
  assert.deepEqual((await readAdReports(db, ownerId, own.id)).links.map(item => item.creativeId), [replacement]);
  await linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId });
  for (const id of [outsider, elsewhere, randomUUID()]) await rejects(linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId: id }), "not_found");
  await rejects(linkAdReportCreative(db, { ownerId, projectId: own.id, reportId: report.id, adId: "invented", creativeId }), "not_found");
  const original = await saveAdObservation(db, { ownerId, projectId: own.id, status: "observation", text: "Owner-observed result in this cohort", reportIds: [report.id], creativeIds: [creativeId] });
  const supersession = await saveAdObservation(db, { ownerId, projectId: own.id, status: "tested", text: "Later local test, not a universal rule", reportIds: [later.id], supersedesId: original.id });
  assert.equal(supersession.supersedesId, original.id);
  await assert.rejects(db.query("UPDATE ad_report_observations SET body='rewritten' WHERE id=$1", [original.id]), /immutable/);
  await rejects(saveAdObservation(db, { ownerId, projectId: own.id, status: "observation", text: "Unsupported", reportIds: [] }), "invalid_input");
  await rejects(saveAdObservation(db, { ownerId, projectId: own.id, status: "hypothesis", text: "Wrong evidence", reportIds: [randomUUID()] }), "not_found");
  await db.query("DELETE FROM creative_assets WHERE id=$1", [creativeId]);
  assert.deepEqual((await readAdReports(db, ownerId, own.id)).links, []);
  assert.deepEqual((await readAdReports(db, ownerId, own.id)).observations.find(o => o.id === original.id).creativeIds, []);
  await deleteAdReport(db, { ownerId, projectId: own.id, reportId: report.id });
  const remaining = await readAdReports(db, ownerId, own.id);
  assert.deepEqual(remaining.observations, []); assert.deepEqual(remaining.reports.map(r => r.id), [later.id]);
});

test("archiving rejects every report mutation, while private reads remain available", async t => {
  const db = await database(t), own = await project(db), { report } = await add(db, own.id);
  await updateProject(db, { ownerId, id: own.id, revision: 1, name: own.name, context: own.context, archived: true });
  assert.equal((await readAdReports(db, ownerId, own.id)).reports.length, 1);
  for (const request of [add(db, own.id, "new"), setAdReportConsent(db, { ownerId, projectId: own.id, aiAnalysis: true, consentVersion: 0 }), deleteAdReport(db, { ownerId, projectId: own.id, reportId: report.id }), saveAdObservation(db, { ownerId, projectId: own.id, status: "observation", text: "Archive", reportIds: [report.id] })]) await rejects(request, "conflict");
});

test("project count and project/owner byte quotas use owner's closure lock", async t => {
  const db = await database(t), own = await project(db), elsewhere = await project(db);
  const fixture = bundle();
  for (let i = 0; i < MAX_PROJECT_REPORTS; i++) await db.query("INSERT INTO ad_reports(id,project_id,owner_id,content_fingerprint,bundle,byte_length) VALUES($1,$2,$3,$4,$5,100)", [randomUUID(), own.id, ownerId, i.toString(16).padStart(64, "0"), JSON.stringify(fixture)]);
  await rejects(add(db, own.id), "limit"); await db.query("DELETE FROM ad_reports WHERE project_id=$1", [own.id]);
  await db.query("INSERT INTO ad_reports(id,project_id,owner_id,content_fingerprint,bundle,byte_length) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), own.id, ownerId, "b".repeat(64), JSON.stringify(fixture), MAX_PROJECT_REPORT_BYTES]);
  await rejects(add(db, own.id), "limit"); await db.query("DELETE FROM ad_reports WHERE project_id=$1", [own.id]);
  await db.query("INSERT INTO ad_reports(id,project_id,owner_id,content_fingerprint,bundle,byte_length) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), elsewhere.id, ownerId, "c".repeat(64), JSON.stringify(fixture), MAX_OWNER_REPORT_BYTES]);
  const statements = [];
  const logging = { ...db, transaction: operation => db.transaction(sql => operation({ ...sql, query: (text, values) => { statements.push(text); return sql.query(text, values); } })) };
  await rejects(add(logging, own.id), "limit"); assert.match(statements[0], /pg_advisory_xact_lock.*hashtextextended/);
});

test("account closure cascades every private ads table despite creatives deleting first", async t => {
  const db = await database(t), accountId = randomUUID(), closingOwner = `account:${accountId}`;
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name) VALUES($1,987123,$2,'invented','Invented')", [accountId, closingOwner]);
  const own = await project(db, closingOwner), creativeId = await asset(db, closingOwner, own.id);
  const { report } = await importAdReport(db, { ownerId: closingOwner, projectId: own.id, bundle: bundle() });
  await setAdReportConsent(db, { ownerId: closingOwner, projectId: own.id, aiAnalysis: true, consentVersion: 0 });
  await linkAdReportCreative(db, { ownerId: closingOwner, projectId: own.id, reportId: report.id, adId: "ad-1", creativeId });
  await saveAdObservation(db, { ownerId: closingOwner, projectId: own.id, status: "observation", text: "Invented finding", reportIds: [report.id], creativeIds: [creativeId] });
  await closeAccount(db, { id: accountId, ownerId: closingOwner });
  for (const table of ["ad_reports", "ad_report_settings", "ad_report_consents", "ad_report_creative_links", "ad_report_observations", "ad_report_observation_reports", "ad_report_observation_creatives"]) assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner_id=$1`, [closingOwner])).rows[0].count, 0, table);
  assert.equal(await readAdReportsForAi(db, closingOwner, own.id, 1), null);
  await assert.rejects(db.query("INSERT INTO ad_report_settings(project_id,owner_id) VALUES($1,$2)", [own.id, closingOwner]), /owner is closed/);
  await rejects(importAdReport(db, { ownerId: closingOwner, projectId: own.id, bundle: bundle() }), "not_found");
});
