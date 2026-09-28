import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { readCreativeAsset, requireProject, insertAsset } from "../creative/storage.ts";
import { uiLayoutSchema, exportRobloxUi } from "./layout.ts";
import type { UiLayout } from "./layout-contract.ts";

export const UI_SHARE_NOTICE_VERSION = "ui-sharing-1";
// This must be shown beside a future sharing control, not hidden in a guide.
// It is separate from optional private-analytics/platform-improvement consent.
export const UI_SHARE_NOTICE = "Share this UI under CC BY 4.0. Others may use and adapt it commercially with attribution. Removing it stops new downloads here; existing licences remain.";
export const UI_ASSET_LICENSE = "CC-BY-4.0";
export const UI_ASSET_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export class UiLibraryError extends Error {
  readonly code: "not_found" | "conflict" | "rights_required" | "consent_required";
  constructor(code: UiLibraryError["code"]) { super(`UI library: ${code}.`); this.name = "UiLibraryError"; this.code = code; }
}
const shortText = (max: number) => z.string().trim().min(1).max(max);
const assetKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const assetMapSchema = z.record(assetKey, idSchema).refine((value) => Object.keys(value).length <= 12);
const draftSchema = z.object({ title: shortText(100), description: z.string().trim().max(500), tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(12), layout: uiLayoutSchema, assets: assetMapSchema }).strict();
type Entry = { id: string; owner_id: string; project_id: string; state: "draft" | "shared" | "withdrawn" | "deleted"; revision: number; title: string; description: string; tags: string[]; layout: UiLayout | null; assets: Record<string, string>; source_entry_ids: string[]; license: string | null; attribution: string | null; credits: string[]; consent_version: string | null };
type Rights = { status: string; attribution: string; license: string };

// Serialize publish/reuse/withdraw/rights changes. A withdrawal cannot lose to
// a queued publication or copy that used stale consent. This small local slice
// can later replace the coarse lock with a consistently ordered dependency lock.
async function libraryLock(sql: Sql) { await sql.query("SELECT id FROM ui_library_lock WHERE id=true FOR UPDATE"); }
async function ownerEntry(sql: Sql, ownerId: string, id: string) {
  const { rows } = await sql.query<Entry>("SELECT * FROM ui_library_entries WHERE id=$1 AND owner_id=$2 AND state <> 'deleted'", [idSchema.parse(id), ownerIdSchema.parse(ownerId)]);
  if (!rows[0]) throw new UiLibraryError("not_found");
  return rows[0];
}
async function sharedEntry(sql: Sql, id: string) {
  const { rows } = await sql.query<Entry>("SELECT * FROM ui_library_entries WHERE id=$1 AND state='shared'", [idSchema.parse(id)]);
  if (!rows[0]) throw new UiLibraryError("not_found");
  return rows[0];
}
function publicEntry(entry: Entry) {
  // Never spread the database row into a public/search/tool response.
  return { id: entry.id, revision: entry.revision, title: entry.title, description: entry.description, tags: entry.tags, license: UI_ASSET_LICENSE, licenseUrl: UI_ASSET_LICENSE_URL, attribution: entry.attribution, credits: entry.credits, assetKeys: Object.keys(entry.assets) };
}
function validateMapping(layout: UiLayout, assets: Record<string, string>) {
  const keys = new Set(layout.nodes.flatMap((node) => node.imageKey ? [node.imageKey] : []));
  if (keys.size !== Object.keys(assets).length || Object.keys(assets).some((key) => !keys.has(key))) throw new UiLibraryError("conflict");
}

export async function createUiEntry(database: Database, ownerId: string, projectId: string, input: unknown) {
  const data = draftSchema.parse(input);
  validateMapping(data.layout, data.assets);
  return database.transaction(async sql => {
    await libraryLock(sql);
    await requireProject(sql, ownerId, projectId);
    for (const id of Object.values(data.assets)) await readCreativeAsset(sql, ownerId, projectId, id);
    const id = randomUUID();
    await sql.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets) VALUES($1,$2,$3,'draft',$4,$5,$6,$7,$8)", [id, ownerId, projectId, data.title, data.description, [...new Set(data.tags)], JSON.stringify(data.layout), JSON.stringify(data.assets)]);
    return ownerEntry(sql, ownerId, id);
  });
}

export async function readPrivateUiEntry(database: Database, ownerId: string, id: string) { return ownerEntry(database, ownerId, id); }

export async function updateUiEntry(database: Database, ownerId: string, id: string, revision: number, input: unknown) {
  const data = draftSchema.parse(input);
  z.number().int().positive().parse(revision);
  validateMapping(data.layout, data.assets);
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    const entry = await ownerEntry(sql, ownerId, id);
    if (entry.state === "shared" || entry.revision !== revision) throw new UiLibraryError("conflict");
    for (const assetId of Object.values(data.assets)) await readCreativeAsset(sql, ownerId, entry.project_id, assetId);
    // Reuse lineage and licence notices survive adaptation, including layouts
    // that remove all original images but still adapt the original structure.
    await sql.query("UPDATE ui_library_entries SET state='draft',revision=revision+1,title=$2,description=$3,tags=$4,layout=$5,assets=$6,consent_version=NULL WHERE id=$1", [entry.id, data.title, data.description, [...new Set(data.tags)], JSON.stringify(data.layout), JSON.stringify(data.assets)]);
    return ownerEntry(sql, ownerId, id);
  });
}

// This records the owner's declaration, not a claim that Romanum independently
// verified a contract. It requires a separate right to redistribute commercially;
// the existing creative-reference permission to use an image is insufficient.
export async function declareUiAssetRights(database: Database, input: { ownerId: string; projectId: string; assetId: string; license: typeof UI_ASSET_LICENSE; attribution: string; evidence: string; confirmed: true }) {
  const data = z.object({ ownerId: ownerIdSchema, projectId: idSchema, assetId: idSchema, license: z.literal(UI_ASSET_LICENSE), attribution: shortText(300), evidence: shortText(2000), confirmed: z.literal(true) }).strict().parse(input);
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    await readCreativeAsset(sql, data.ownerId, data.projectId, data.assetId);
    const affected = await sql.query<{ entry_id: string }>("SELECT entry_id FROM ui_library_sources WHERE asset_id=$1", [data.assetId]);
    await withdrawTree(sql, affected.rows.map((row) => row.entry_id));
    await sql.query("INSERT INTO ui_asset_rights(asset_id,owner_id,project_id,status,license,attribution,evidence_private) VALUES($1,$2,$3,'granted',$4,$5,$6) ON CONFLICT(asset_id) DO UPDATE SET status='granted',license=excluded.license,attribution=excluded.attribution,evidence_private=excluded.evidence_private,updated_at=now()", [data.assetId, data.ownerId, data.projectId, data.license, data.attribution, data.evidence]);
    return { assetId: data.assetId, status: "granted" as const };
  });
}

async function publicationLineage(sql: Sql, entry: Entry) {
  const sources = new Set<string>(), dependencies = new Set<string>(), credits = new Set<string>();
  const active = new Set<string>();
  async function inherit(originId: string) {
    const origin = await sharedEntry(sql, originId);
    if (origin.id === entry.id) throw new UiLibraryError("rights_required");
    dependencies.add(origin.id);
    const inherited = await sql.query<{ source_entry_id: string }>("SELECT source_entry_id FROM ui_library_dependencies WHERE entry_id=$1", [origin.id]);
    for (const item of inherited.rows) {
      await sharedEntry(sql, item.source_entry_id);
      dependencies.add(item.source_entry_id);
    }
    if (dependencies.has(entry.id) || dependencies.size > 64) throw new UiLibraryError("rights_required");
    for (const credit of origin.credits) credits.add(credit);
    if (origin.attribution) credits.add(origin.attribution);
  }
  async function visit(id: string, depth: number) {
    if (active.has(id) || depth > 16 || sources.size >= 64) throw new UiLibraryError("rights_required");
    if (sources.has(id)) return;
    active.add(id);
    const asset = await readCreativeAsset(sql, entry.owner_id, entry.project_id, id);
    const { rows } = await sql.query<Rights>("SELECT status,attribution,license FROM ui_asset_rights WHERE asset_id=$1 AND owner_id=$2", [id, entry.owner_id]);
    if (rows[0]?.status !== "granted" || rows[0].license !== UI_ASSET_LICENSE || asset.metadata.mode === "test") throw new UiLibraryError("rights_required");
    credits.add(rows[0].attribution);
    const originId = asset.metadata.libraryEntryId;
    if (originId !== undefined) {
      if (typeof originId !== "string") throw new UiLibraryError("rights_required");
      await inherit(originId);
    }
    if (asset.kind === "generated") {
      const { rows: jobs } = await sql.query<{ request: { referenceIds?: unknown }; provider_mode: string }>("SELECT request,provider_mode FROM creative_jobs WHERE output_asset_id=$1 AND owner_id=$2 AND project_id=$3 AND status='succeeded'", [id, entry.owner_id, entry.project_id]);
      if (jobs.length !== 1 || jobs[0].provider_mode === "test" || !Array.isArray(jobs[0].request.referenceIds)) throw new UiLibraryError("rights_required");
      for (const reference of jobs[0].request.referenceIds) {
        if (typeof reference !== "string") throw new UiLibraryError("rights_required");
        await visit(reference, depth + 1);
      }
    }
    active.delete(id);
    sources.add(id);
  }
  for (const id of entry.source_entry_ids) await inherit(id);
  for (const id of Object.values(entry.assets)) await visit(id, 0);
  return { sources, dependencies, credits: [...credits].sort() };
}

export async function shareUiEntry(database: Database, input: { ownerId: string; entryId: string; revision: number; attribution: string; license: typeof UI_ASSET_LICENSE; noticeVersion: typeof UI_SHARE_NOTICE_VERSION; confirmed: true }) {
  const data = z.object({ ownerId: ownerIdSchema, entryId: idSchema, revision: z.number().int().positive(), attribution: shortText(300), license: z.literal(UI_ASSET_LICENSE), noticeVersion: z.literal(UI_SHARE_NOTICE_VERSION), confirmed: z.literal(true) }).strict().parse(input);
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    const entry = await ownerEntry(sql, data.ownerId, data.entryId);
    if (entry.revision !== data.revision || entry.state === "shared") throw new UiLibraryError("conflict");
    const lineage = await publicationLineage(sql, entry);
    await sql.query("DELETE FROM ui_library_sources WHERE entry_id=$1", [entry.id]);
    await sql.query("DELETE FROM ui_library_dependencies WHERE entry_id=$1", [entry.id]);
    for (const id of lineage.sources) await sql.query("INSERT INTO ui_library_sources VALUES($1,$2)", [entry.id, id]);
    for (const id of lineage.dependencies) await sql.query("INSERT INTO ui_library_dependencies VALUES($1,$2)", [entry.id, id]);
    await sql.query("UPDATE ui_library_entries SET state='shared',revision=revision+1,license=$2,attribution=$3,credits=$4,consent_version=$5,shared_at=now() WHERE id=$1", [entry.id, data.license, data.attribution, JSON.stringify(lineage.credits), data.noticeVersion]);
    await sql.query("INSERT INTO ui_library_events(entry_id,owner_id,action,revision,notice_version) VALUES($1,$2,'shared',$3,$4)", [entry.id, data.ownerId, entry.revision + 1, data.noticeVersion]);
    return publicEntry(await sharedEntry(sql, entry.id));
  });
}

async function withdrawTree(sql: Sql, ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await sql.query<{ id: string; owner_id: string; revision: number }>("WITH RECURSIVE affected(id) AS (SELECT id FROM ui_library_entries WHERE id=ANY($1::uuid[]) UNION SELECT d.entry_id FROM ui_library_dependencies d JOIN affected a ON d.source_entry_id=a.id) UPDATE ui_library_entries SET state='withdrawn',revision=revision+1 WHERE id IN (SELECT id FROM affected) AND state='shared' RETURNING id,owner_id,revision", [ids]);
  for (const row of rows) await sql.query("INSERT INTO ui_library_events(entry_id,owner_id,action,revision) VALUES($1,$2,'withdrawn',$3)", [row.id, row.owner_id, row.revision]);
  return rows.map((row) => row.id);
}
export async function withdrawUiEntry(database: Database, ownerId: string, id: string) {
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    const entry = await ownerEntry(sql, ownerId, id);
    const withdrawn = await withdrawTree(sql, [entry.id]);
    if (!withdrawn.includes(entry.id)) {
      // Even a draft can have an in-flight share confirmation. Invalidate its
      // revision so an older confirmation cannot publish after withdrawal.
      await sql.query("UPDATE ui_library_entries SET state='withdrawn',revision=revision+1 WHERE id=$1", [entry.id]);
      await sql.query("INSERT INTO ui_library_events(entry_id,owner_id,action,revision) VALUES($1,$2,'withdrawn',$3)", [entry.id, ownerId, entry.revision + 1]);
      withdrawn.push(entry.id);
    }
    return { withdrawn };
  });
}
export async function revokeUiAssetRights(database: Database, ownerId: string, projectId: string, assetId: string) {
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    await readCreativeAsset(sql, ownerId, projectId, assetId);
    await sql.query("UPDATE ui_asset_rights SET status='revoked',updated_at=now() WHERE asset_id=$1 AND owner_id=$2", [assetId, ownerId]);
    const { rows } = await sql.query<{ entry_id: string }>("SELECT entry_id FROM ui_library_sources WHERE asset_id=$1", [assetId]);
    return { withdrawn: await withdrawTree(sql, rows.map((row) => row.entry_id)) };
  });
}
export async function deleteUiEntry(database: Database, ownerId: string, id: string) {
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    const tombstone = await sql.query("SELECT id FROM ui_library_entries WHERE id=$1 AND owner_id=$2 AND state='deleted'", [idSchema.parse(id), ownerIdSchema.parse(ownerId)]);
    if (tombstone.rows.length) return { deleted: true };
    const entry = await ownerEntry(sql, ownerId, id);
    await withdrawTree(sql, [entry.id]);
    // Delete the listing's content. Its owner's private project assets and
    // other users' previously licensed copies are separate, not silently erased.
    await sql.query("UPDATE ui_library_entries SET state='deleted',revision=revision+1,title='',description='',tags='{}',layout=NULL,assets='{}',source_entry_ids='[]',attribution=NULL,credits='[]',consent_version=NULL WHERE id=$1", [entry.id]);
    await sql.query("DELETE FROM ui_library_sources WHERE entry_id=$1", [entry.id]);
    await sql.query("DELETE FROM ui_library_dependencies WHERE entry_id=$1", [entry.id]);
    await sql.query("INSERT INTO ui_library_events(entry_id,owner_id,action,revision) SELECT id,owner_id,'deleted',revision FROM ui_library_entries WHERE id=$1", [entry.id]);
    return { deleted: true };
  });
}

export async function searchSharedUi(database: Database, input: unknown = {}) {
  const { query, tags, limit } = z.object({ query: z.string().trim().max(100).default(""), tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(6).default([]), limit: z.number().int().min(1).max(30).default(12) }).strict().parse(input);
  // strpos makes wildcard characters literal and SQL parameters contain all input.
  const { rows } = await database.query<Entry>("SELECT * FROM ui_library_entries WHERE state='shared' AND ($1='' OR strpos(lower(title || ' ' || description),lower($1))>0) AND tags @> $2::text[] ORDER BY shared_at DESC,id LIMIT $3", [query, tags, limit]);
  return rows.map(publicEntry);
}
export async function readSharedUiAsset(database: Database, entryId: string, key: string) {
  assetKey.parse(key);
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    const entry = await sharedEntry(sql, entryId);
    const id = entry.assets[key];
    if (!id) throw new UiLibraryError("not_found");
    const asset = await readCreativeAsset(sql, entry.owner_id, entry.project_id, id);
    return { bytes: asset.bytes, mimeType: asset.mime_type, width: asset.width, height: asset.height, license: UI_ASSET_LICENSE, attribution: entry.attribution, credits: entry.credits };
  });
}

export async function reuseSharedUi(database: Database, ownerId: string, projectId: string, entryId: string) {
  return database.transaction(async (sql) => {
    await libraryLock(sql);
    await requireProject(sql, ownerId, projectId);
    const entry = await sharedEntry(sql, entryId);
    const assets: Record<string, string> = {};
    for (const [key, id] of Object.entries(entry.assets)) {
      const original = await readCreativeAsset(sql, entry.owner_id, entry.project_id, id);
      const attribution = entry.attribution!;
      const copiedId = await insertAsset(sql, { ownerId, projectId, kind: "reference", bytes: original.bytes, metadata: { label: key, rights: "licensed", rightsNote: UI_ASSET_LICENSE_URL, libraryEntryId: entry.id, libraryRevision: entry.revision, attribution } });
      assets[key] = copiedId;
      await sql.query("INSERT INTO ui_asset_rights(asset_id,owner_id,project_id,status,license,attribution,evidence_private) VALUES($1,$2,$3,'granted',$4,$5,$6)", [copiedId, ownerId, projectId, UI_ASSET_LICENSE, attribution, `Licensed library copy: ${entry.id}, revision ${entry.revision}`]);
    }
    const draftId = randomUUID();
    await sql.query("INSERT INTO ui_library_entries(id,owner_id,project_id,state,title,description,tags,layout,assets,source_entry_ids,license,attribution,credits) VALUES($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12)", [draftId, ownerId, projectId, entry.title, entry.description, entry.tags, JSON.stringify(entry.layout), JSON.stringify(assets), JSON.stringify([entry.id]), UI_ASSET_LICENSE, entry.attribution, JSON.stringify(entry.credits)]);
    return { entryId: draftId, revision: 1, layout: entry.layout!, assets, license: UI_ASSET_LICENSE, licenseUrl: UI_ASSET_LICENSE_URL, attribution: entry.attribution, credits: entry.credits, sourceEntryId: entry.id, sourceRevision: entry.revision };
  });
}

export async function exportPrivateUi(database: Database, ownerId: string, id: string, robloxAssetIds: Record<string, number>) {
  const entry = await ownerEntry(database, ownerId, id);
  const credits = [...new Set([...(entry.attribution ? [entry.attribution] : []), ...entry.credits])];
  const notice = entry.license ? `-- Asset licence: ${UI_ASSET_LICENSE_URL}\n-- Attribution: ${credits.join("; ").replace(/[\r\n\u2028\u2029]/g, " ")}\n` : "";
  return { source: notice + exportRobloxUi(entry.layout, robloxAssetIds), license: entry.license, credits, assetKeys: Object.keys(entry.assets), implemented: false };
}
