import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../history/database.ts";
import { contextSchema, idSchema, ownerIdSchema, type ProjectContext } from "../creative/schema.ts";

// Private project storage for the Romanum workspace. A project is one owner's
// brief and the context anything generated from it will use. Every read and
// write is scoped to an opaque owner ID, and projects are archived rather than
// deleted so their context survives. This module is server-only: import its
// types into the browser with `import type`, never as a value.

/** Projects one owner may keep, archived ones included. */
export const MAX_PROJECTS = 100;
/** `ProjectSummary.description` is the gameplay line, cut to this many characters. */
const DESCRIPTION_LIMIT = 200;

export type ProjectBrief = { id: string; name: string; context: ProjectContext; revision: number; archived: boolean; updatedAt: string };
export type ProjectSummary = { id: string; name: string; description: string; revision: number; archived: boolean; updatedAt: string };

export class ProjectError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict" | "limit";
  constructor(code: ProjectError["code"], message: string) { super(message); this.name = "ProjectError"; this.code = code; }
}

/** The request body for creating a project. Ownership is never accepted here. */
export const projectInputSchema = z.object({ name: z.string().trim().min(1).max(100), context: contextSchema }).strict();
/** The request body for updating a project. Revision selects the exact edit it was based on. */
export const projectUpdateSchema = projectInputSchema.extend({ revision: z.number().int().positive(), archived: z.boolean() }).strict();

type ProjectRow = { id: string; name: string; context: ProjectContext; revision: number; archived: boolean; updated_at: Date | string };
const COLUMNS = "id, name, context, revision, archived, updated_at";

const owner = (value: unknown): string => {
  const parsed = ownerIdSchema.safeParse(value);
  if (!parsed.success) throw new ProjectError("invalid_input", "The owner of this project is invalid.");
  return parsed.data;
};

const brief = (row: ProjectRow): ProjectBrief => ({
  id: row.id, name: row.name, context: row.context, revision: row.revision, archived: row.archived,
  updatedAt: new Date(row.updated_at).toISOString(),
});

// The gameplay line as written, cut to a bounded summary with nothing invented.
const summary = (row: ProjectRow): ProjectSummary => ({
  id: row.id, name: row.name, description: row.context.gameplay.slice(0, DESCRIPTION_LIMIT),
  revision: row.revision, archived: row.archived, updatedAt: new Date(row.updated_at).toISOString(),
});

/** Creates a draft project. Bounded by {@link MAX_PROJECTS} per owner, archived ones included. */
export async function createProject(
  database: Database,
  input: { ownerId: string; name: string; context: ProjectContext },
): Promise<ProjectBrief> {
  const ownerId = owner(input.ownerId);
  const parsed = projectInputSchema.safeParse({ name: input.name, context: input.context });
  if (!parsed.success) throw new ProjectError("invalid_input", "A project needs a name of up to 100 characters and a game title.");
  const id = randomUUID();
  return database.transaction(async (sql) => {
    // Serialise creation per owner so the cap holds even for concurrent requests.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
    await sql.query("SELECT pg_advisory_xact_lock(hashtext('romanum_projects'), hashtext($1))", [ownerId]);
    const { rows } = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM creative_projects WHERE owner_id=$1", [ownerId]);
    if (rows[0].count >= MAX_PROJECTS) throw new ProjectError("limit", `You can keep up to ${MAX_PROJECTS} projects.`);
    const { rows: created } = await sql.query<ProjectRow>(
      `INSERT INTO creative_projects(id, owner_id, name, context) VALUES ($1,$2,$3,$4) RETURNING ${COLUMNS}`,
      [id, ownerId, parsed.data.name, JSON.stringify(parsed.data.context)],
    );
    return brief(created[0]);
  });
}

/** Reads one owner's project, archived ones included. A malformed ID is simply not found. */
export async function readProject(database: Database, ownerId: string, id: string): Promise<ProjectBrief | null> {
  if (!idSchema.safeParse(id).success) return null;
  const { rows } = await database.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM creative_projects WHERE id=$1 AND owner_id=$2`,
    [id, owner(ownerId)],
  );
  return rows[0] ? brief(rows[0]) : null;
}

/** Lists one owner's projects, most recently updated first, at most {@link MAX_PROJECTS}. */
export async function listProjects(database: Database, ownerId: string, options: { archived?: boolean } = {}): Promise<ProjectSummary[]> {
  if (options.archived !== undefined && typeof options.archived !== "boolean") {
    throw new ProjectError("invalid_input", "The archived filter must be true or false.");
  }
  const { rows } = await database.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM creative_projects WHERE owner_id=$1 AND archived=$2 ORDER BY updated_at DESC, id LIMIT ${MAX_PROJECTS}`,
    [owner(ownerId), options.archived ?? false],
  );
  return rows.map(summary);
}

/**
 * Replaces an existing project's name, context and archived flag. The revision
 * must match the one the caller last saw, so two edits cannot silently overwrite
 * each other; the winning edit increments it. The ID and owner never change.
 */
export async function updateProject(
  database: Database,
  input: { ownerId: string; id: string; revision: number; name: string; context: ProjectContext; archived: boolean },
): Promise<ProjectBrief> {
  const ownerId = owner(input.ownerId);
  if (!idSchema.safeParse(input.id).success) throw new ProjectError("not_found", "Project not found.");
  const parsed = projectUpdateSchema.safeParse({ name: input.name, context: input.context, revision: input.revision, archived: input.archived });
  if (!parsed.success) throw new ProjectError("invalid_input", "Check the project details, revision and archived flag.");
  return database.transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
    const { rows } = await sql.query<ProjectRow>(
      `UPDATE creative_projects SET name=$3, context=$4, archived=$5, revision=revision+1, updated_at=now()
       WHERE id=$1 AND owner_id=$2 AND revision=$6 RETURNING ${COLUMNS}`,
      [input.id, ownerId, parsed.data.name, JSON.stringify(parsed.data.context), parsed.data.archived, parsed.data.revision],
    );
    if (rows[0]) return brief(rows[0]);
    // No row matched: either this owner has no such project, or the revision is stale.
    const { rows: existing } = await sql.query("SELECT 1 AS found FROM creative_projects WHERE id=$1 AND owner_id=$2", [input.id, ownerId]);
    if (!existing[0]) throw new ProjectError("not_found", "Project not found.");
    throw new ProjectError("conflict", "This project changed since you last saw it. Reload and try again.");
  });
}
