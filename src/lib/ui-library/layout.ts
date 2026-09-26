// Romanum UI library — declarative layout schema and static Roblox export.
//
// This module handles declarative UI only. It never stores, runs or uploads
// scripts or images: exportRobloxUi compiles a validated layout into a plain
// Luau snippet a developer pastes into Roblox Studio. Image pixels are
// referenced by a numeric asset id the caller supplies; the export publishes
// nothing and does not parent the result to a player's UI.
//
// Instance class and property names follow the official Roblox engine
// references for ScreenGui and ImageLabel (and their GuiObject ancestors):
// https://create.roblox.com/docs/reference/engine/classes/ScreenGui
// https://create.roblox.com/docs/reference/engine/classes/ImageLabel
//
// Covered by the root Romanum Source-Available License. Emitted game UI is
// creative output under section 4 of that licence.

import { z } from "zod";
import type { UiDimension, UiLayout, UiNode } from "./layout-contract.ts";

/** Raised when a layout is valid but the caller's asset ids cannot be used. */
export class UiExportError extends Error {}

// A layout can only name an image by key. Keys are slugs, so a URL can never be
// smuggled in as an image source; the numeric asset id is resolved separately.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

const classNameSchema = z.enum(["Frame", "TextLabel", "TextButton", "ImageLabel", "ImageButton"]);
const TEXT_CLASSES: ReadonlySet<string> = new Set(["TextLabel", "TextButton"]);
const IMAGE_CLASSES: ReadonlySet<string> = new Set(["ImageLabel", "ImageButton"]);

// Names and text stay arbitrary (Roblox instance names and label content accept
// most characters) and are escaped on export. Only a NUL byte is refused here,
// because it cannot survive a C-style Luau string literal cleanly.
function stringField(min: number, max: number) {
  return z.string().min(min).max(max).refine((value) => !value.includes("\0"), "Control NUL is not allowed.");
}

const slugSchema = z.string().regex(SLUG_PATTERN, "Use a lowercase slug: letters, digits and dashes.");
const rgbChannel = z.number().int().min(0).max(255);
const rgbSchema = z.tuple([rgbChannel, rgbChannel, rgbChannel]);

// UDim2 components: scale is a fraction of the parent, offset is pixels.
const scaleSchema = z.number().min(-2).max(2);
const offsetSchema = z.number().min(-4096).max(4096);
const sizeScaleSchema = z.number().min(0).max(2);
const sizeOffsetSchema = z.number().min(0).max(4096);

const dimensionSchema = z.object({
  xScale: scaleSchema, xOffset: offsetSchema, yScale: scaleSchema, yOffset: offsetSchema,
}).strict();
const sizeDimensionSchema = z.object({
  xScale: sizeScaleSchema, xOffset: sizeOffsetSchema, yScale: sizeScaleSchema, yOffset: sizeOffsetSchema,
}).strict();
const anchorSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();

// Class-specific fields are enforced after the shape check: text belongs to
// text classes, imageKey to image classes, and nothing else may carry either.
function checkNodeClass(node: UiNode, ctx: z.RefinementCtx): void {
  const isText = TEXT_CLASSES.has(node.className);
  const isImage = IMAGE_CLASSES.has(node.className);
  if (isText) {
    if (node.text === undefined) ctx.addIssue({ code: "custom", message: `${node.className} requires text.`, path: ["text"] });
  } else {
    if (node.text !== undefined) ctx.addIssue({ code: "custom", message: `${node.className} cannot carry text.`, path: ["text"] });
    if (node.textColor !== undefined) ctx.addIssue({ code: "custom", message: `${node.className} cannot carry textColor.`, path: ["textColor"] });
    if (node.textSize !== undefined) ctx.addIssue({ code: "custom", message: `${node.className} cannot carry textSize.`, path: ["textSize"] });
  }
  if (!isImage && node.imageKey !== undefined) {
    ctx.addIssue({ code: "custom", message: `${node.className} cannot carry imageKey.`, path: ["imageKey"] });
  }
}

const nodeSchema = z.object({
  id: slugSchema,
  parentId: slugSchema.nullable(),
  className: classNameSchema,
  name: stringField(1, 80),
  position: dimensionSchema,
  size: sizeDimensionSchema,
  anchorPoint: anchorSchema,
  backgroundColor: rgbSchema,
  backgroundTransparency: z.number().min(0).max(1),
  zIndex: z.number().int().min(1).max(100),
  cornerRadius: z.number().min(0).max(128).optional(),
  text: stringField(0, 1000).optional(),
  textColor: rgbSchema.optional(),
  textSize: z.number().min(10).max(100).optional(),
  imageKey: slugSchema.optional(),
}).strict().superRefine(checkNodeClass);

// Whole-layout rules: unique ids, resolvable parents, an acyclic forest, and a
// bounded number of distinct image keys.
function checkLayout(layout: UiLayout, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  layout.nodes.forEach((node, index) => {
    if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: "Node ids must be unique.", path: ["nodes", index, "id"] });
    ids.add(node.id);
  });

  layout.nodes.forEach((node, index) => {
    if (node.parentId === null) return;
    if (node.parentId === node.id) ctx.addIssue({ code: "custom", message: "A node cannot parent itself.", path: ["nodes", index, "parentId"] });
    else if (!ids.has(node.parentId)) ctx.addIssue({ code: "custom", message: "Parent node does not exist.", path: ["nodes", index, "parentId"] });
  });

  const parentOf = new Map(layout.nodes.map((node) => [node.id, node.parentId]));
  let cycled = false;
  for (const node of layout.nodes) {
    const seen = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        ctx.addIssue({ code: "custom", message: "Node parenting must not contain cycles.", path: ["nodes"] });
        cycled = true;
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (cycled) break;
  }

  const imageKeys = new Set<string>();
  for (const node of layout.nodes) if (node.imageKey !== undefined) imageKeys.add(node.imageKey);
  if (imageKeys.size > 12) ctx.addIssue({ code: "custom", message: "A layout may reference at most 12 image keys.", path: ["nodes"] });
}

export const uiLayoutSchema: z.ZodType<UiLayout> = z.object({
  version: z.literal(1),
  name: stringField(1, 80),
  nodes: z.array(nodeSchema).min(1).max(100),
}).strict().superRefine(checkLayout);

// Deterministic parent-first order. Kahn's algorithm seeds nodes with no parent
// in input order, so equal layouts always produce byte-identical output.
function topologicalOrder(nodes: UiNode[]): UiNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
    indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const ordered: UiNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    ordered.push(byId.get(id) as UiNode);
    for (const child of children.get(id) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ordered.length !== nodes.length) throw new UiExportError("Layout parenting is not acyclic.");
  return ordered;
}

// Plain decimal, never exponent notation, so the snippet is stable and readable.
function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return String(value);
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUdim2(dimension: UiDimension): string {
  const { xScale, xOffset, yScale, yOffset } = dimension;
  return `UDim2.new(${formatNumber(xScale)}, ${formatNumber(xOffset)}, ${formatNumber(yScale)}, ${formatNumber(yOffset)})`;
}

function formatColor(rgb: [number, number, number]): string {
  return `Color3.fromRGB(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

// Arbitrary names and text become byte-safe Luau literals: every byte outside
// printable ASCII, plus the quote and backslash bytes, is written as a
// three-digit decimal escape. The result is inert data, never executable code.
function luauString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '"';
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e || byte === 0x22 || byte === 0x5c) out += `\\${byte.toString().padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

export function exportRobloxUi(layout: unknown, assetIds: Record<string, number>): string {
  const parsed = uiLayoutSchema.parse(layout);
  const assets = assetIds ?? {};

  // A numeric, positive, whole Roblox asset id is required for every referenced
  // image key. A URL, a Luau string literal or a missing key is refused.
  const imageIds = new Map<string, number>();
  const usedImageKeys = new Set<string>();
  for (const node of parsed.nodes) if (node.imageKey !== undefined) usedImageKeys.add(node.imageKey);
  for (const key of [...usedImageKeys].sort()) {
    const id = assets[key];
    if (typeof id !== "number" || !Number.isFinite(id) || !Number.isSafeInteger(id) || id <= 0) {
      throw new UiExportError(`Image "${key}" needs a positive whole Roblox asset id.`);
    }
    imageIds.set(key, id);
  }

  const ordered = topologicalOrder(parsed.nodes);
  const lines: string[] = [
    "-- Romanum UI library export.",
    "-- Declarative layout compiled to a static Luau snippet for Roblox Studio.",
    "-- The snippet builds a ScreenGui and returns it; nothing is uploaded or published.",
    `-- Parent the returned ScreenGui wherever you need it (for example a player's PlayerGui).`,
    "",
    'local screenGui = Instance.new("ScreenGui")',
    `screenGui.Name = ${luauString(parsed.name)}`,
    "screenGui.IgnoreGuiInset = true",
    "screenGui.ResetOnSpawn = false",
  ];

  const variableFor = new Map<string, string>();
  ordered.forEach((node, index) => {
    const variable = `node${index + 1}`;
    variableFor.set(node.id, variable);
    lines.push("", `local ${variable} = Instance.new("${node.className}")`);
    lines.push(`${variable}.Name = ${luauString(node.name)}`);
    lines.push(`${variable}.Position = ${formatUdim2(node.position)}`);
    lines.push(`${variable}.Size = ${formatUdim2(node.size)}`);
    lines.push(`${variable}.AnchorPoint = Vector2.new(${formatNumber(node.anchorPoint.x)}, ${formatNumber(node.anchorPoint.y)})`);
    lines.push(`${variable}.BackgroundColor3 = ${formatColor(node.backgroundColor)}`);
    lines.push(`${variable}.BackgroundTransparency = ${formatNumber(node.backgroundTransparency)}`);
    lines.push(`${variable}.BorderSizePixel = 0`);
    lines.push(`${variable}.ZIndex = ${node.zIndex}`);
    if (node.text !== undefined) lines.push(`${variable}.Text = ${luauString(node.text)}`);
    if (node.textColor !== undefined) lines.push(`${variable}.TextColor3 = ${formatColor(node.textColor)}`);
    if (node.textSize !== undefined) lines.push(`${variable}.TextSize = ${formatNumber(node.textSize)}`);
    if (node.imageKey !== undefined) lines.push(`${variable}.Image = ${luauString(`rbxassetid://${imageIds.get(node.imageKey)}`)}`);
    else if (IMAGE_CLASSES.has(node.className)) lines.push(`${variable}.Image = ""`);
    if (node.cornerRadius !== undefined) {
      const corner = `corner${index + 1}`;
      lines.push("", `local ${corner} = Instance.new("UICorner")`);
      lines.push(`${corner}.CornerRadius = UDim.new(0, ${formatNumber(node.cornerRadius)})`);
      lines.push(`${corner}.Parent = ${variable}`);
    }
    lines.push(`${variable}.Parent = ${node.parentId === null ? "screenGui" : variableFor.get(node.parentId)}`);
  });

  lines.push("", "return screenGui", "");
  return lines.join("\n");
}
