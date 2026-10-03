import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import type { ImageLibraryQuery } from "./types.ts";

export const IMAGE_LIBRARY_PAGE_SIZE = 12;
export const IMAGE_LIBRARY_MAX_PAGE_SIZE = 24;
export const IMAGE_LIBRARY_MAX_QUERY_LENGTH = 2048;
export class ImageLibraryInputError extends Error {}

const querySchema = z.object({
  q: z.string().trim().max(80).default(""),
  kind: z.enum(["all", "thumbnail", "ui", "other"]).default("all"),
  stage: z.enum(["all", "concept", "final", "asset"]).default("all"),
  projectId: idSchema.optional(),
  limit: z.string().regex(/^(?:[1-9]|1\d|2[0-4])$/).optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const cursorSchema = z.tuple([z.literal(1), z.string().regex(/^[a-f0-9]{64}$/), z.iso.datetime(), idSchema]);
const resolvedQuerySchema = z.object({
  q: z.string().trim().max(80), kind: z.enum(["all", "thumbnail", "ui", "other"]),
  stage: z.enum(["all", "concept", "final", "asset"]), projectId: idSchema.nullable(),
  limit: z.number().int().min(1).max(IMAGE_LIBRARY_MAX_PAGE_SIZE),
  after: z.object({ createdAt: z.iso.datetime(), id: idSchema }).strict().nullable(),
}).strict();
export function validateImageLibraryQuery(value: unknown): ImageLibraryQuery {
  const parsed = resolvedQuerySchema.safeParse(value);
  if (!parsed.success) throw new ImageLibraryInputError();
  return parsed.data;
}
function scope(ownerId: string, query: Omit<ImageLibraryQuery, "after">): string {
  return createHash("sha256").update(JSON.stringify([ownerId, query.q, query.kind, query.stage, query.projectId, query.limit])).digest("hex");
}

/** Cursors bind owner and filters but never replace the SQL ownership predicates. */
export function imageLibraryCursor(ownerId: string, query: ImageLibraryQuery, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([1, scope(ownerId, query), createdAt, id])).toString("base64url");
}

export function parseImageLibraryQuery(params: URLSearchParams, ownerId: string): ImageLibraryQuery {
  if (params.toString().length > IMAGE_LIBRARY_MAX_QUERY_LENGTH || !ownerIdSchema.safeParse(ownerId).success) throw new ImageLibraryInputError();
  const input: Record<string, string> = {};
  for (const key of params.keys()) {
    if (!Object.hasOwn(querySchema.shape, key) || params.getAll(key).length !== 1) throw new ImageLibraryInputError();
    input[key] = params.get(key)!;
  }
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new ImageLibraryInputError();
  const { cursor, ...filters } = parsed.data;
  const query: ImageLibraryQuery = { ...filters, projectId: filters.projectId ?? null, limit: filters.limit ? Number(filters.limit) : IMAGE_LIBRARY_PAGE_SIZE, after: null };
  if (cursor) {
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new ImageLibraryInputError(); }
    const valid = cursorSchema.safeParse(decoded);
    if (!valid.success || valid.data[1] !== scope(ownerId, query)) throw new ImageLibraryInputError();
    query.after = { createdAt: valid.data[2], id: valid.data[3] };
  }
  return validateImageLibraryQuery(query);
}

export function imageLibrarySearchParams(input: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) { for (const item of value) params.append(key, item); }
    else if (value !== undefined) params.append(key, value);
  }
  return params;
}
