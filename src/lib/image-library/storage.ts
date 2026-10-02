import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../history/database.ts";
import { inspectPng, MAX_IMAGE_BYTES } from "../creative/image-provider.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { imageLibraryCursor, validateImageLibraryQuery } from "./query.ts";
import type { ImageLibraryStorage, LibraryImage, LibraryImageDetail } from "./types.ts";

// Only generated assets, with ownership repeated on the parent and generation lineage.
// A left join preserves legitimate generated copies whose original job isn't recorded.
const FROM = `FROM creative_assets a
  JOIN creative_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
  LEFT JOIN LATERAL (
    SELECT j.stage,j.provider_id,j.provider_model,j.provider_mode,j.request->>'prompt' AS prompt,w.kind,
      (SELECT c->>'title' FROM jsonb_array_elements(w.concepts) c WHERE c->>'key'=j.concept_key LIMIT 1) AS title
    FROM creative_jobs j JOIN creative_workflows w ON w.id=j.workflow_id AND w.owner_id=j.owner_id AND w.project_id=j.project_id
    WHERE j.output_asset_id=a.id AND j.owner_id=a.owner_id AND j.project_id=a.project_id AND j.status='succeeded'
    ORDER BY j.finished_at DESC NULLS LAST,j.id LIMIT 1
  ) g ON true`;
const OWNED = "a.owner_id=$1 AND p.owner_id=$1 AND a.kind='generated'";
const KIND = "COALESCE(g.kind,'other')";
const TITLE = "left(COALESCE(g.title,a.metadata->>'label','Generated image'),100)";
// Retain microseconds in the cursor so images created in the same millisecond cannot be skipped.
const COLUMNS = `a.id,a.project_id,left(p.name,100) AS project_name,${TITLE} AS title,
  to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  a.width,a.height,octet_length(a.bytes)::int AS byte_length,${KIND} AS image_kind,
  COALESCE(g.stage,a.metadata->>'stage') AS stage,
  left(COALESCE(g.provider_id,a.metadata->>'provider'),120) AS provider,
  left(COALESCE(g.provider_model,a.metadata->>'model'),120) AS model,
  COALESCE(g.provider_mode,a.metadata->>'mode') AS mode`;
type Row = {
  id: string; project_id: string; project_name: string; title: string; created_at: string;
  width: number; height: number; byte_length: number; image_kind: unknown; stage: unknown;
  provider: unknown; model: unknown; mode: unknown; prompt?: string | null; prompt_truncated?: boolean;
};
const summarySchema = z.object({
  id: idSchema, projectId: idSchema, projectName: z.string().max(100), title: z.string().min(1).max(100),
  createdAt: z.iso.datetime(), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  byteLength: z.number().int().min(45).max(MAX_IMAGE_BYTES),
});
const identifier = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value) ? value : null;
function summary(row: Row): LibraryImage {
  return {
    ...summarySchema.parse({ id: row.id, projectId: row.project_id, projectName: row.project_name, title: row.title || "Generated image", createdAt: row.created_at, width: row.width, height: row.height, byteLength: row.byte_length }),
    generation: {
      kind: row.image_kind === "thumbnail" || row.image_kind === "ui" ? row.image_kind : "other",
      stage: row.stage === "concept" || row.stage === "final" || row.stage === "asset" ? row.stage : null,
      provider: identifier(row.provider), model: identifier(row.model),
      mode: row.mode === "test" || row.mode === "paid" ? row.mode : null,
    },
  };
}

/** Reuses the real bytea persistence contract. No writes, storage URLs, probes, or provider calls. */
export function databaseImageLibraryStorage(sql: Sql): ImageLibraryStorage {
  return {
    async list(ownerId, input) {
      const owner = ownerIdSchema.parse(ownerId);
      const query = validateImageLibraryQuery(input);
      const { rows } = await sql.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE ${OWNED}
        AND ($2::text='' OR strpos(lower(concat_ws(' ',p.name,${TITLE},g.provider_model)),lower($2))>0)
        AND ($3::text='all' OR ${KIND}=$3) AND ($4::text='all' OR COALESCE(g.stage,a.metadata->>'stage')=$4)
        AND ($5::uuid IS NULL OR a.project_id=$5)
        AND ($6::timestamptz IS NULL OR (a.created_at,a.id)<($6::timestamptz,$7::uuid))
        ORDER BY a.created_at DESC,a.id DESC LIMIT $8`,
      [owner, query.q, query.kind, query.stage, query.projectId, query.after?.createdAt ?? null, query.after?.id ?? null, query.limit + 1]);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return { images: page.map(summary), nextCursor: rows.length > query.limit && last ? imageLibraryCursor(owner, query, last.created_at, last.id) : null };
    },
    async detail(ownerId, id) {
      if (!idSchema.safeParse(id).success || !ownerIdSchema.safeParse(ownerId).success) return null;
      const { rows } = await sql.query<Row>(`SELECT ${COLUMNS},left(g.prompt,8000) AS prompt,COALESCE(length(g.prompt)>8000,false) AS prompt_truncated ${FROM} WHERE ${OWNED} AND a.id=$2`, [ownerId, id]);
      const row = rows[0];
      if (!row) return null;
      const result: LibraryImageDetail = { ...summary(row), prompt: typeof row.prompt === "string" ? row.prompt : null, promptTruncated: row.prompt_truncated === true };
      return result;
    },
    async file(ownerId, id) {
      if (!idSchema.safeParse(id).success || !ownerIdSchema.safeParse(ownerId).success) return { status: "missing" };
      const { rows } = await sql.query<{ bytes: Uint8Array; mime_type: string; width: number; height: number; sha256: string }>(
        `SELECT a.bytes,a.mime_type,a.width,a.height,a.sha256 FROM creative_assets a
         JOIN creative_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
         WHERE ${OWNED} AND a.id=$2 AND octet_length(a.bytes) BETWEEN 45 AND $3`, [ownerId, id, MAX_IMAGE_BYTES]);
      const row = rows[0];
      if (!row || row.mime_type !== "image/png") return { status: "missing" };
      try {
        const shape = inspectPng(row.bytes);
        if (shape.width !== row.width || shape.height !== row.height || createHash("sha256").update(row.bytes).digest("hex") !== row.sha256) return { status: "missing" };
      } catch { return { status: "missing" }; }
      return { status: "ready", bytes: row.bytes, mimeType: "image/png" };
    },
  };
}
