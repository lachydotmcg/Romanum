import { z } from "zod";
import type { Database } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { insertAsset } from "../creative/storage.ts";
import { normalizeProjectImage } from "../chats/image-input.ts";

// Private project reference images. A reference belongs to one owner and one of
// that owner's projects, holds no public sharing right, and is never exposed
// outside an owner-scoped read. Uploads are decoded and re-encoded server-side
// (metadata and EXIF stripped) before storage, so an original file never reaches
// the database or a model. Every managed reference is marked with a source tag,
// which keeps internal generated images and library copies invisible here.

/** Managed references one project may keep. */
export const MAX_PROJECT_REFERENCES = 24;
/** Private image bytes one owner may keep across every project and asset kind. */
export const MAX_OWNER_REFERENCE_BYTES = 25 * 1024 * 1024;

/** Only references this service created carry this marker. */
const SOURCE_MARKER = "project-upload";

export class ReferenceError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict" | "limit";
  constructor(code: ReferenceError["code"], message: string) {
    super(message);
    this.name = "ReferenceError";
    this.code = code;
  }
}

/** The plain reference input. Performance claims and extra fields are refused. */
export const referenceInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  rights: z.enum(["owned", "licensed"]),
  rightsNote: z.string().trim().min(1).max(500),
}).strict();

export type ReferenceSummary = {
  id: string;
  projectId: string;
  label: string;
  rights: "owned" | "licensed";
  rightsNote: string;
  width: number;
  height: number;
  byteLength: number;
  createdAt: string;
};

type ReferenceRow = {
  id: string;
  project_id: string;
  width: number;
  height: number;
  byte_length: number;
  metadata: unknown;
  created_at: Date | string;
  bytes?: Uint8Array;
};

// A stored marker row is only summarised if its plain metadata still parses, so
// an unexpected shape degrades to "not visible" instead of leaking a field.
const storedMetadataSchema = z.object({
  label: z.string().min(1).max(100),
  rights: z.enum(["owned", "licensed"]),
  rightsNote: z.string().min(1).max(500),
});

// Listing deliberately names its columns; `bytes` is only ever measured, never read.
const SUMMARY_COLUMNS = "id, project_id, width, height, octet_length(bytes)::int AS byte_length, metadata, created_at";
const MANAGED_SCOPE = "owner_id=$1 AND project_id=$2 AND kind='reference' AND metadata->>'source'=$3";

const ownerOrNull = (value: unknown): string | null => {
  const parsed = ownerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const idOrNull = (value: unknown): string | null => {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const summary = (row: ReferenceRow): ReferenceSummary | null => {
  const metadata = storedMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    label: metadata.data.label,
    rights: metadata.data.rights,
    rightsNote: metadata.data.rightsNote,
    width: row.width,
    height: row.height,
    byteLength: row.byte_length,
    createdAt: new Date(row.created_at).toISOString(),
  };
};

/** Lists one owner's managed references for a project they own. Archived projects still read. */
export async function listProjectReferences(database: Database, ownerId: string, projectId: string): Promise<ReferenceSummary[]> {
  const owner = ownerOrNull(ownerId);
  const project = idOrNull(projectId);
  if (!owner || !project) throw new ReferenceError("not_found", "Project not found.");
  const { rows: owned } = await database.query("SELECT 1 AS found FROM creative_projects WHERE id=$1 AND owner_id=$2", [project, owner]);
  if (!owned[0]) throw new ReferenceError("not_found", "Project not found.");
  const { rows } = await database.query<ReferenceRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM creative_assets WHERE ${MANAGED_SCOPE} ORDER BY created_at DESC, id LIMIT ${MAX_PROJECT_REFERENCES}`,
    [owner, project, SOURCE_MARKER],
  );
  return rows.map(summary).filter((reference): reference is ReferenceSummary => reference !== null);
}

/**
 * Reads one managed reference and its stored PNG bytes. A malformed or
 * out-of-scope request is simply `null`, so an outsider learns nothing.
 */
export async function readProjectReference(
  database: Database,
  ownerId: string,
  projectId: string,
  id: string,
): Promise<{ reference: ReferenceSummary; bytes: Uint8Array } | null> {
  const owner = ownerOrNull(ownerId);
  const project = idOrNull(projectId);
  const referenceId = idOrNull(id);
  if (!owner || !project || !referenceId) return null;
  const { rows } = await database.query<ReferenceRow>(
    `SELECT ${SUMMARY_COLUMNS}, bytes FROM creative_assets WHERE id=$4 AND ${MANAGED_SCOPE}`,
    [owner, project, SOURCE_MARKER, referenceId],
  );
  const row = rows[0];
  if (!row || !row.bytes) return null;
  const reference = summary(row);
  if (!reference) return null;
  return { reference, bytes: row.bytes };
}

/**
 * Normalises and stores one private reference. Decoding happens before the
 * write transaction; the transaction then re-checks ownership, the per-project
 * cap and the owner's byte quota under the owner's advisory lock, so a
 * concurrent upload or account closure cannot slip past the limits.
 */
export async function addProjectReference(
  database: Database,
  input: { ownerId: string; projectId: string; bytes: Uint8Array; metadata: unknown },
): Promise<ReferenceSummary> {
  const owner = ownerOrNull(input.ownerId);
  const project = idOrNull(input.projectId);
  if (!owner || !project) throw new ReferenceError("invalid_input", "The owner or project of this reference is invalid.");
  const metadata = referenceInputSchema.safeParse(input.metadata);
  if (!metadata.success) {
    throw new ReferenceError("invalid_input", "A reference needs a label, a rights basis and a rights note.");
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new ReferenceError("invalid_input", "A reference image is required.");
  }
  // Cheap ownership check before the expensive decode.
  const active = await database.query<{ archived: boolean }>(
    "SELECT archived FROM creative_projects WHERE id=$1 AND owner_id=$2",
    [project, owner],
  );
  if (!active.rows[0]) throw new ReferenceError("not_found", "Project not found.");
  if (active.rows[0].archived) throw new ReferenceError("conflict", "This project is archived. Restore it before adding references.");

  // The shared decoder already replaces raw failures with a safe ImageInputError.
  const bytes = await normalizeProjectImage(input.bytes);

  const stored = { ...metadata.data, source: SOURCE_MARKER };
  return database.transaction(async (sql) => {
    // The same lock account closure takes, so quota and closure cannot interleave.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
    const { rows: locked } = await sql.query<{ archived: boolean }>(
      "SELECT archived FROM creative_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [project, owner],
    );
    if (!locked[0]) throw new ReferenceError("not_found", "Project not found.");
    if (locked[0].archived) throw new ReferenceError("conflict", "This project is archived. Restore it before adding references.");
    const { rows: counted } = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM creative_assets WHERE ${MANAGED_SCOPE}`,
      [owner, project, SOURCE_MARKER],
    );
    if (counted[0].count >= MAX_PROJECT_REFERENCES) {
      throw new ReferenceError("limit", `A project can keep up to ${MAX_PROJECT_REFERENCES} reference images. Delete one first.`);
    }
    const { rows: used } = await sql.query<{ total: string }>(
      "SELECT COALESCE(sum(octet_length(bytes)),0)::bigint AS total FROM creative_assets WHERE owner_id=$1",
      [owner],
    );
    if (Number(used[0].total) + bytes.byteLength > MAX_OWNER_REFERENCE_BYTES) {
      throw new ReferenceError("limit", "Your private image storage is full. Delete some images and try again.");
    }
    const id = await insertAsset(sql, { ownerId: owner, projectId: project, kind: "reference", bytes, metadata: stored });
    const { rows } = await sql.query<ReferenceRow>(`SELECT ${SUMMARY_COLUMNS} FROM creative_assets WHERE id=$1`, [id]);
    const created = rows[0] ? summary(rows[0]) : null;
    if (!created) throw new ReferenceError("invalid_input", "The reference could not be saved.");
    return created;
  });
}

// Lineage that must block deletion: any saved creative work or public listing
// that cites the asset. Checked globally so another owner's rows are never
// deleted to make room.
const USAGE_SQL = `
SELECT 1 FROM creative_workflows WHERE reference_ids @> $2::jsonb
UNION ALL SELECT 1 FROM creative_jobs WHERE request->'referenceIds' @> $2::jsonb OR output_asset_id = $1::uuid
UNION ALL SELECT 1 FROM creative_reviews WHERE asset_id = $1::uuid
UNION ALL SELECT 1 FROM creative_reconciliations WHERE output_asset_id = $1::uuid
UNION ALL SELECT 1 FROM ui_asset_rights WHERE asset_id = $1::uuid
UNION ALL SELECT 1 FROM ui_library_sources WHERE asset_id = $1::uuid
UNION ALL SELECT 1 FROM ui_library_entries e WHERE EXISTS (SELECT 1 FROM jsonb_each_text(e.assets) AS kv(k, v) WHERE kv.v = $3)
LIMIT 1`;

/**
 * Deletes one unused managed reference. The library lock, the owner advisory
 * lock and a row lock are taken in the same order as the rest of the app, so a
 * concurrent share, reuse or account closure cannot race the delete. A
 * reference cited by any saved work or listing is refused rather than broken.
 * Deletion of an archived project's reference is allowed.
 */
export async function deleteProjectReference(database: Database, ownerId: string, projectId: string, id: string): Promise<void> {
  const owner = ownerOrNull(ownerId);
  const project = idOrNull(projectId);
  const referenceId = idOrNull(id);
  if (!owner || !project || !referenceId) throw new ReferenceError("not_found", "Reference not found.");
  await database.transaction(async (sql) => {
    await sql.query("SELECT id FROM ui_library_lock WHERE id=true FOR UPDATE");
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM creative_assets WHERE id=$4 AND ${MANAGED_SCOPE} FOR UPDATE`,
      [owner, project, SOURCE_MARKER, referenceId],
    );
    if (!rows[0]) throw new ReferenceError("not_found", "Reference not found.");
    const { rows: used } = await sql.query(USAGE_SQL, [referenceId, JSON.stringify([referenceId]), referenceId]);
    if (used[0]) throw new ReferenceError("conflict", "This reference is used by saved creative work. Remove those first.");
    await sql.query(`DELETE FROM creative_assets WHERE id=$4 AND ${MANAGED_SCOPE}`, [owner, project, SOURCE_MARKER, referenceId]);
  });
}
