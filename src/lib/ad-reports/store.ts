import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import type { AdReportBundle } from "./types.ts";
import { validateAdReportBundle } from "./import.ts";

export const MAX_PROJECT_REPORTS = 50;
export const MAX_PROJECT_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_OWNER_REPORT_BYTES = 25 * 1024 * 1024;
export const MAX_PROJECT_OBSERVATIONS = 200;
export const MAX_PROJECT_CREATIVE_LINKS = 500;
export class AdReportError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict" | "limit";
  constructor(code: AdReportError["code"], message: string) { super(message); this.name = "AdReportError"; this.code = code; }
}
export type AdReportSettings = { aiAnalysis: boolean; platformImprovement: false; consentVersion: number };
export type StoredAdReport = { id: string; projectId: string; bundle: AdReportBundle; context: AdReportBundle["context"]; contentFingerprint: string; createdAt: string };
export type AdReportCreativeLink = { id: string; reportId: string; adId: string; creativeId: string; createdAt: string };
export type AdObservation = { id: string; status: "observation" | "hypothesis" | "tested"; text: string; reportIds: string[]; creativeIds: string[]; supersedesId: string | null; createdAt: string };
export type AdReportsSnapshot = { reports: StoredAdReport[]; settings: AdReportSettings; links: AdReportCreativeLink[]; observations: AdObservation[] };
type Scope = { ownerId: string; projectId: string };
const scopeSchema = z.object({ ownerId: ownerIdSchema, projectId: idSchema });
const uniqueIds = z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length);
const observationSchema = scopeSchema.extend({ status: z.enum(["observation", "hypothesis", "tested"]), text: z.string().trim().min(1).max(4000), reportIds: uniqueIds.refine(ids => ids.length > 0), creativeIds: uniqueIds.default([]), supersedesId: idSchema.optional() }).strict();
const linkSchema = scopeSchema.extend({ reportId: idSchema, adId: z.string().trim().min(1).max(200), creativeId: idSchema }).strict();
const consentSchema = scopeSchema.extend({ aiAnalysis: z.boolean(), consentVersion: z.number().int().nonnegative() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new AdReportError("invalid_input", "Check the report details."); return result.data; }
const iso = (value: unknown) => new Date(value as string).toISOString();
function report(row: Record<string, unknown>): StoredAdReport { const bundle = validateAdReportBundle(row.bundle); return { id: String(row.id), projectId: String(row.project_id), bundle, context: bundle.context, contentFingerprint: String(row.content_fingerprint), createdAt: iso(row.created_at) }; }
const REPORT_COLUMNS = "id,project_id,bundle,content_fingerprint,created_at";
/** Logical identity excludes ZIP packaging and preserves each explicit context.
 * Raw upload/file hashes and filenames remain unchanged in the stored bundle.
 */
function contentFingerprint(bundle: AdReportBundle): string {
  const context = bundle.context;
  const files = bundle.files.map(file => JSON.stringify([file.grain, file.cohort, file.entityType, file.sha256])).sort();
  const identity = {
    version: bundle.version,
    context: [context.periodStart, context.periodEnd, context.timezone, context.attributionWindow, context.placement, context.audience, context.currency],
    files,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
async function owned(sql: Sql, scope: Scope, write = false) {
  const { rows } = await sql.query<{ archived: boolean }>(`SELECT archived FROM creative_projects WHERE id=$1 AND owner_id=$2${write ? " FOR UPDATE" : ""}`, [scope.projectId, scope.ownerId]);
  if (!rows[0]) throw new AdReportError("not_found", "Project not found.");
  if (write && rows[0].archived) throw new AdReportError("conflict", "Restore this project before changing reports.");
}
async function write<T>(db: Database, scope: Scope, operation: (sql: Sql) => Promise<T>): Promise<T> {
  return db.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope.ownerId]);
    await owned(sql, scope, true);
    return operation(sql);
  });
}
async function settings(sql: Sql, scope: Scope): Promise<AdReportSettings> {
  const { rows } = await sql.query<{ ai_analysis: boolean; consent_version: number }>("SELECT ai_analysis,consent_version FROM ad_report_settings WHERE project_id=$1 AND owner_id=$2", [scope.projectId, scope.ownerId]);
  return { aiAnalysis: rows[0]?.ai_analysis ?? false, platformImprovement: false, consentVersion: rows[0]?.consent_version ?? 0 };
}
export async function readAdReportSettings(db: Database, ownerId: string, projectId: string): Promise<AdReportSettings> {
  const scope = parse(scopeSchema, { ownerId, projectId }); await owned(db, scope); return settings(db, scope);
}
async function snapshot(sql: Sql, scope: Scope): Promise<AdReportsSnapshot> {
  const reports = await sql.query(`SELECT ${REPORT_COLUMNS} FROM ad_reports WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id LIMIT ${MAX_PROJECT_REPORTS}`, [scope.projectId, scope.ownerId]);
  const links = await sql.query("SELECT id,report_id,ad_id,creative_id,created_at FROM ad_report_creative_links WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at,id LIMIT 500", [scope.projectId, scope.ownerId]);
  const observations = await sql.query(`SELECT o.id,o.status,o.body,o.supersedes_id,o.created_at,
    COALESCE((SELECT jsonb_agg(r.report_id ORDER BY r.report_id) FROM ad_report_observation_reports r WHERE r.observation_id=o.id),'[]') AS report_ids,
    COALESCE((SELECT jsonb_agg(c.creative_id ORDER BY c.creative_id) FROM ad_report_observation_creatives c WHERE c.observation_id=o.id),'[]') AS creative_ids
    FROM ad_report_observations o WHERE o.project_id=$1 AND o.owner_id=$2 ORDER BY o.created_at DESC,o.id LIMIT 200`, [scope.projectId, scope.ownerId]);
  return {
    reports: reports.rows.map(report), settings: await settings(sql, scope),
    links: links.rows.map(row => ({ id: String(row.id), reportId: String(row.report_id), adId: String(row.ad_id), creativeId: String(row.creative_id), createdAt: iso(row.created_at) })),
    observations: observations.rows.map(row => ({ id: String(row.id), status: row.status as AdObservation["status"], text: String(row.body), reportIds: row.report_ids as string[], creativeIds: row.creative_ids as string[], supersedesId: row.supersedes_id as string | null, createdAt: iso(row.created_at) })),
  };
}
export async function readAdReports(db: Database, ownerId: string, projectId: string): Promise<AdReportsSnapshot> {
  const scope = parse(scopeSchema, { ownerId, projectId });
  return db.transaction(async sql => { await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope.ownerId]); await owned(sql, scope); return snapshot(sql, scope); });
}
/** Check again immediately before each provider call. Never inherit other consent. */
export async function readAdReportsForAi(db: Database, ownerId: string, projectId: string, expectedConsentVersion?: number): Promise<AdReportsSnapshot | null> {
  try {
    const result = await readAdReports(db, ownerId, projectId);
    return result.settings.aiAnalysis && (expectedConsentVersion === undefined || result.settings.consentVersion === expectedConsentVersion) ? result : null;
  } catch (error) { if (error instanceof AdReportError && error.code === "not_found") return null; throw error; }
}
export async function importAdReport(db: Database, input: Scope & { bundle: AdReportBundle }): Promise<{ report: StoredAdReport; duplicate: boolean }> {
  const scope = parse(scopeSchema, input); let bundle: AdReportBundle;
  try { bundle = validateAdReportBundle(input.bundle); } catch { throw new AdReportError("invalid_input", "Invalid normalized report."); }
  const json = JSON.stringify(bundle), bytes = Buffer.byteLength(json), fingerprint = contentFingerprint(bundle);
  if (bytes > MAX_PROJECT_REPORT_BYTES) throw new AdReportError("limit", "Report storage is full.");
  return write(db, scope, async sql => {
    const existing = await sql.query(`SELECT ${REPORT_COLUMNS} FROM ad_reports WHERE project_id=$1 AND owner_id=$2 AND content_fingerprint=$3`, [scope.projectId, scope.ownerId, fingerprint]);
    if (existing.rows[0]) return { report: report(existing.rows[0]), duplicate: true };
    const used = await sql.query<{ count: number; project_bytes: string; owner_bytes: string }>("SELECT count(*) FILTER (WHERE project_id=$2)::int AS count,COALESCE(sum(byte_length) FILTER (WHERE project_id=$2),0)::bigint AS project_bytes,COALESCE(sum(byte_length),0)::bigint AS owner_bytes FROM ad_reports WHERE owner_id=$1", [scope.ownerId, scope.projectId]);
    if (used.rows[0].count >= MAX_PROJECT_REPORTS || Number(used.rows[0].project_bytes) + bytes > MAX_PROJECT_REPORT_BYTES || Number(used.rows[0].owner_bytes) + bytes > MAX_OWNER_REPORT_BYTES) throw new AdReportError("limit", "Report storage is full.");
    const saved = await sql.query(`INSERT INTO ad_reports(id,project_id,owner_id,content_fingerprint,bundle,byte_length) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${REPORT_COLUMNS}`, [randomUUID(), scope.projectId, scope.ownerId, fingerprint, json, bytes]);
    return { report: report(saved.rows[0]), duplicate: false };
  });
}
export async function setAdReportConsent(db: Database, input: Scope & { aiAnalysis: boolean; consentVersion: number }): Promise<AdReportSettings> {
  const parsed = parse(consentSchema, input);
  return write(db, parsed, async sql => {
    const previous = await settings(sql, parsed);
    if (previous.consentVersion !== parsed.consentVersion) throw new AdReportError("conflict", "Consent changed. Refresh before saving.");
    if (previous.aiAnalysis === parsed.aiAnalysis) return previous;
    const version = previous.consentVersion + 1;
    await sql.query("INSERT INTO ad_report_settings(project_id,owner_id,ai_analysis,consent_version) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,owner_id) DO UPDATE SET ai_analysis=EXCLUDED.ai_analysis,consent_version=EXCLUDED.consent_version,updated_at=now()", [parsed.projectId, parsed.ownerId, parsed.aiAnalysis, version]);
    await sql.query("INSERT INTO ad_report_consents(id,project_id,owner_id,ai_analysis,consent_version) VALUES($1,$2,$3,$4,$5)", [randomUUID(), parsed.projectId, parsed.ownerId, parsed.aiAnalysis, version]);
    return { aiAnalysis: parsed.aiAnalysis, platformImprovement: false, consentVersion: version };
  });
}
async function assertMembers(sql: Sql, scope: Scope, table: "ad_reports" | "creative_assets" | "ad_report_observations", ids: string[]) {
  if (!ids.length) return;
  const { rows } = await sql.query(`SELECT id FROM ${table} WHERE project_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[])`, [scope.projectId, scope.ownerId, ids]);
  if (rows.length !== ids.length) throw new AdReportError("not_found", "Report or creative not found.");
}
export async function linkAdReportCreative(db: Database, input: Scope & { reportId: string; adId: string; creativeId: string }): Promise<AdReportCreativeLink> {
  const parsed = parse(linkSchema, input);
  return write(db, parsed, async sql => {
    await assertMembers(sql, parsed, "creative_assets", [parsed.creativeId]);
    const source = await sql.query("SELECT bundle FROM ad_reports WHERE id=$1 AND project_id=$2 AND owner_id=$3", [parsed.reportId, parsed.projectId, parsed.ownerId]);
    const bundle = source.rows[0] ? validateAdReportBundle(source.rows[0].bundle) : null;
    if (!bundle || !bundle.files.some(file => file.rows.some(row => row.adId === parsed.adId))) throw new AdReportError("not_found", "Ad not found in this report.");
    const existing = await sql.query("SELECT id,report_id,ad_id,creative_id,created_at FROM ad_report_creative_links WHERE report_id=$1 AND ad_id=$2", [parsed.reportId, parsed.adId]);
    let row = existing.rows[0];
    if (row && row.creative_id !== parsed.creativeId) {
      row = (await sql.query("UPDATE ad_report_creative_links SET creative_id=$1,created_at=now() WHERE id=$2 AND project_id=$3 AND owner_id=$4 RETURNING id,report_id,ad_id,creative_id,created_at", [parsed.creativeId, row.id, parsed.projectId, parsed.ownerId])).rows[0];
    } else if (!row) {
      const count = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM ad_report_creative_links WHERE project_id=$1 AND owner_id=$2", [parsed.projectId, parsed.ownerId]);
      if (count.rows[0].count >= MAX_PROJECT_CREATIVE_LINKS) throw new AdReportError("limit", "Creative link storage is full.");
      row = (await sql.query("INSERT INTO ad_report_creative_links(id,project_id,owner_id,report_id,ad_id,creative_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,report_id,ad_id,creative_id,created_at", [randomUUID(), parsed.projectId, parsed.ownerId, parsed.reportId, parsed.adId, parsed.creativeId])).rows[0];
    }
    return { id: String(row.id), reportId: String(row.report_id), adId: String(row.ad_id), creativeId: String(row.creative_id), createdAt: iso(row.created_at) };
  });
}
export async function saveAdObservation(db: Database, input: Scope & { status: AdObservation["status"]; text: string; reportIds: string[]; creativeIds?: string[]; supersedesId?: string }): Promise<AdObservation> {
  const parsed = parse(observationSchema, input);
  return write(db, parsed, async sql => {
    await assertMembers(sql, parsed, "ad_reports", parsed.reportIds);
    await assertMembers(sql, parsed, "creative_assets", parsed.creativeIds);
    if (parsed.supersedesId) await assertMembers(sql, parsed, "ad_report_observations", [parsed.supersedesId]);
    const count = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM ad_report_observations WHERE project_id=$1 AND owner_id=$2", [parsed.projectId, parsed.ownerId]);
    if (count.rows[0].count >= MAX_PROJECT_OBSERVATIONS) throw new AdReportError("limit", "Observation storage is full.");
    const id = randomUUID();
    const created = await sql.query("INSERT INTO ad_report_observations(id,project_id,owner_id,status,body,supersedes_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at", [id, parsed.projectId, parsed.ownerId, parsed.status, parsed.text, parsed.supersedesId ?? null]);
    for (const reportId of parsed.reportIds) await sql.query("INSERT INTO ad_report_observation_reports(observation_id,project_id,owner_id,report_id) VALUES($1,$2,$3,$4)", [id, parsed.projectId, parsed.ownerId, reportId]);
    for (const creativeId of parsed.creativeIds) await sql.query("INSERT INTO ad_report_observation_creatives(observation_id,project_id,owner_id,creative_id) VALUES($1,$2,$3,$4)", [id, parsed.projectId, parsed.ownerId, creativeId]);
    return { id, status: parsed.status, text: parsed.text, reportIds: [...parsed.reportIds].sort(), creativeIds: [...parsed.creativeIds].sort(), supersedesId: parsed.supersedesId ?? null, createdAt: iso(created.rows[0].created_at) };
  });
}
/** Deletes dependent observations (including supersessions) and explicit links. */
export async function deleteAdReport(db: Database, input: Scope & { reportId: string }): Promise<void> {
  const parsed = parse(scopeSchema.extend({ reportId: idSchema }).strict(), input);
  await write(db, parsed, async sql => {
    const result = await sql.query("DELETE FROM ad_reports WHERE id=$1 AND project_id=$2 AND owner_id=$3 RETURNING id", [parsed.reportId, parsed.projectId, parsed.ownerId]);
    if (!result.rows[0]) throw new AdReportError("not_found", "Report not found.");
  });
}
