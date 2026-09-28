import { z } from "zod";

export const ownerIdSchema = z.string().trim().min(1).max(200).refine((value) => !value.includes("\0"));
export const idSchema = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
// Draft project context: the game is required, while the rest of the brief may
// still be unwritten. Empty strings are bounded the same way as filled ones.
const draftText = (max: number) => z.string().trim().max(max).default("");
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
export const imageSizeSchema = z.enum(["1024x1024", "1536x1024", "1024x1536"]);
export const contextSchema = z.object({
  game: text(100),
  gameplay: draftText(2000),
  audience: draftText(500),
  artDirection: draftText(1000),
  constraints: z.array(text(300)).max(12).default([]),
  plan: z.string().trim().max(12000).optional(),
  roadmap: z.array(z.object({ title: text(100), detail: z.string().trim().max(1000) }).strict()).max(12).optional(),
  todos: z.array(z.object({ id: key, text: text(300), done: z.boolean() }).strict()).max(40).optional(),
}).strict().refine(context => !context.todos || new Set(context.todos.map(todo => todo.id)).size === context.todos.length, "Todo ids must be unique.");
export const briefSchema = z.object({
  goal: text(1000),
  truthfulContent: text(2000),
  visualDirection: text(1000),
  avoid: z.array(text(200)).max(12).default([]),
}).strict();
export const conceptSchema = z.object({
  key, title: text(80), hypothesis: text(500), prompt: text(2000),
  assets: z.array(z.object({ key, label: text(80), prompt: text(1000), size: imageSizeSchema.default("1024x1024") }).strict()).max(12).default([]),
}).strict().refine((concept) => new Set(concept.assets.map((asset) => asset.key)).size === concept.assets.length, "Asset keys must be unique.");
export const conceptsSchema = z.array(conceptSchema).min(1).max(3).refine((concepts) => new Set(concepts.map((concept) => concept.key)).size === concepts.length, "Concept keys must be unique.");

// A submitted report is not independently verified, nor evidence that it will
// transfer to a different audience. No CCU/likes proxy or generic high-CTR label.
export const performanceSchema = z.object({
  metric: z.enum(["click_through_rate", "play_through_rate", "qualified_play_through_rate"]),
  impressions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outcomes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  from: z.iso.datetime(), to: z.iso.datetime(),
  source: text(500), cohort: text(500),
}).strict().refine((value) => value.outcomes <= value.impressions && Date.parse(value.from) < Date.parse(value.to), "Invalid performance sample.");
export const referenceMetadataSchema = z.object({
  label: text(100),
  rights: z.enum(["owned", "licensed"]),
  rightsNote: text(500),
  performance: performanceSchema.optional(),
}).strict();
export type ProjectContext = z.infer<typeof contextSchema>;
export type CreativeBrief = z.infer<typeof briefSchema>;
export type Concept = z.infer<typeof conceptSchema>;
export type ReferenceMetadata = z.infer<typeof referenceMetadataSchema>;
