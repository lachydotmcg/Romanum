import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../history/database.ts";
import { inspectPng } from "./image-provider.ts";
import { contextSchema, idSchema, ownerIdSchema, referenceMetadataSchema, type ProjectContext, type ReferenceMetadata } from "./schema.ts";

export class CreativeError extends Error {
  readonly code: "not_found" | "conflict" | "unavailable" | "approval_required" | "budget_exceeded";
  constructor(code: CreativeError["code"]) { super(`Creative workflow: ${code}.`); this.name = "CreativeError"; this.code = code; }
}
export type Project = { id: string; owner_id: string; name: string; context: ProjectContext };
export type StoredAsset = { id: string; project_id: string; owner_id: string; bytes: Uint8Array; mime_type: "image/png"; width: number; height: number; kind: "reference" | "generated"; metadata: Record<string, unknown> };

export async function requireProject(sql: Sql, ownerId: string, projectId: string) {
  const { rows } = await sql.query<Project>("SELECT id, owner_id, name, context FROM creative_projects WHERE id=$1 AND owner_id=$2", [idSchema.parse(projectId), ownerIdSchema.parse(ownerId)]);
  if (!rows[0]) throw new CreativeError("not_found");
  return rows[0];
}

export async function createCreativeProject(database: Database, input: { ownerId: string; name: string; context: ProjectContext }) {
  const data = z.object({ ownerId: ownerIdSchema, name: z.string().trim().min(1).max(100), context: contextSchema }).strict().parse(input);
  const id = randomUUID();
  await database.query("INSERT INTO creative_projects(id,owner_id,name,context) VALUES($1,$2,$3,$4)", [id, data.ownerId, data.name, JSON.stringify(data.context)]);
  return { id, ...data };
}

export async function insertAsset(sql: Sql, input: { ownerId: string; projectId: string; kind: "reference" | "generated"; bytes: Uint8Array; metadata: Record<string, unknown> }) {
  const { width, height } = inspectPng(input.bytes);
  const id = randomUUID();
  await sql.query("INSERT INTO creative_assets(id,owner_id,project_id,kind,bytes,mime_type,width,height,sha256,metadata) VALUES($1,$2,$3,$4,$5,'image/png',$6,$7,$8,$9)", [id, input.ownerId, input.projectId, input.kind, Buffer.from(input.bytes), width, height, createHash("sha256").update(input.bytes).digest("hex"), JSON.stringify(input.metadata)]);
  return id;
}

// Trusted local/server call only. No unauthenticated upload or public asset URL.
export async function addCreativeReference(database: Database, input: { ownerId: string; projectId: string; bytes: Uint8Array; metadata: ReferenceMetadata }) {
  const ownerId = ownerIdSchema.parse(input.ownerId), projectId = idSchema.parse(input.projectId);
  const metadata = referenceMetadataSchema.parse(input.metadata);
  await requireProject(database, ownerId, projectId);
  return insertAsset(database, { ownerId, projectId, bytes: input.bytes, kind: "reference", metadata });
}

export async function readCreativeAsset(sql: Sql, ownerId: string, projectId: string, id: string) {
  // A transaction creating a workflow keeps its references alive until commit.
  // Standalone reads release the lock with their implicit transaction.
  const { rows } = await sql.query<StoredAsset>("SELECT id, project_id, owner_id, bytes, mime_type, width, height, kind, metadata FROM creative_assets WHERE id=$1 AND project_id=$2 AND owner_id=$3 FOR KEY SHARE", [idSchema.parse(id), idSchema.parse(projectId), ownerIdSchema.parse(ownerId)]);
  if (!rows[0]) throw new CreativeError("not_found");
  return rows[0];
}

// Compose ledger operations into the caller's transaction so a job and its hold
// (or an output and its capture) commit together. Never use outside a transaction.
export function transactionDatabase(sql: Sql): Database {
  return { ...sql, transaction: (operation) => operation(sql), close: async () => {} };
}
