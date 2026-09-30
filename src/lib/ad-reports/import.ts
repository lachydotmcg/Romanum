import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import type { AdReportBundle, AdReportContext, AdReportFile, AdReportRow, AdReportCohort } from "./types.ts";
import { CANONICAL_DAILY_HEADER } from "./types.ts";
export { CANONICAL_DAILY_HEADER, CANONICAL_DAILY_CSV } from "./types.ts";

export const AD_REPORT_LIMITS = { uploadBytes: 10 * 1024 * 1024, csvBytes: 5 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, files: 20, rows: 20_000, cellChars: 8192 } as const;
export const AD_REPORT_COHORTS = ["AllUsers", "NewUsers", "ReturningUsers", "7DResurrected", "30DResurrected"] as const;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => { const parsed = new Date(`${date}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date; }, "Invalid calendar date");
const contextText = z.string().trim().min(1).max(200).nullable();
export const adReportContextSchema = z.object({ periodStart: dateSchema.nullable(), periodEnd: dateSchema.nullable(), timezone: contextText, attributionWindow: contextText, placement: contextText, audience: contextText, currency: contextText }).strict().superRefine((value, ctx) => {
  if (value.periodStart && value.periodEnd && value.periodStart > value.periodEnd) ctx.addIssue({ code: "custom", message: "Period start must precede end" });
  if (value.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); } catch { ctx.addIssue({ code: "custom", message: "Invalid IANA timezone" }); } }
});
const numberSchema = z.number().finite().nonnegative().nullable();
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const calculatedSchema = z.object({ ctr: numberSchema, playsPerImpression: numberSchema, cpc: numberSchema, cpp: numberSchema }).strict();
const rowSchema = z.object({ sourceLine: z.number().int().positive(), date: dateSchema.nullable(), campaignId: z.string().min(1).max(200), campaignName: z.string().max(8192), adId: z.string().min(1).max(200).nullable(), adName: z.string().max(8192).nullable(), impressions: countSchema, clicks: countSchema, plays: countSchema, spend: numberSchema, paymentType: contextText, reported: z.object({ ctr: numberSchema, playRate: numberSchema, cpc: numberSchema, cpp: numberSchema }).strict(), calculated: calculatedSchema, raw: z.record(z.string().max(200), z.string().max(8192)) }).strict();
const fileSchema = z.object({ name: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/), grain: z.enum(["aggregate", "daily"]), cohort: z.enum(AD_REPORT_COHORTS), entityType: z.enum(["campaign", "ad"]), rows: z.array(rowSchema).max(AD_REPORT_LIMITS.rows) }).strict();
export const adReportBundleSchema = z.object({ version: z.literal(1), format: z.enum(["roblox-aggregate-v1", "romanum-daily-v1", "mixed"]), sha256: z.string().regex(/^[a-f0-9]{64}$/), context: adReportContextSchema, files: z.array(fileSchema).min(1).max(AD_REPORT_LIMITS.files), warnings: z.array(z.string().max(2000)).max(1000) }).strict();
export function validateAdReportContext(value: unknown): AdReportContext { return adReportContextSchema.parse(value); }
export function validateAdReportBundle(value: unknown): AdReportBundle {
  const bundle = adReportBundleSchema.parse(value);
  let count = 0;
  const identities = new Set<string>();
  for (const file of bundle.files) {
    safeName(file.name);
    for (const row of file.rows) {
      count++;
      if ((file.grain === "daily") !== (row.date !== null) || (file.entityType === "ad") !== (row.adId !== null)) throw new Error("Report grain/entity mismatch");
      if (row.date && ((bundle.context.periodStart && row.date < bundle.context.periodStart) || (bundle.context.periodEnd && row.date > bundle.context.periodEnd))) throw new Error("Daily date outside declared period");
      const key = identity(file, row);
      if (identities.has(key)) throw new Error("Duplicate report observation");
      identities.add(key);
      const calculated = calculateAdMetrics(row);
      for (const key of Object.keys(calculated) as (keyof typeof calculated)[]) if (calculated[key] !== row.calculated[key]) throw new Error("Calculated metrics do not match source counts");
    }
  }
  if (count > AD_REPORT_LIMITS.rows) throw new Error("Report row limit exceeded");
  const grains = new Set(bundle.files.map((file) => file.grain));
  const format = grains.size > 1 ? "mixed" : grains.has("daily") ? "romanum-daily-v1" : "roblox-aggregate-v1";
  if (bundle.format !== format) throw new Error("Report format does not match grains");
  return bundle;
}
export function calculateAdMetrics(row: { impressions: number | null; clicks: number | null; plays: number | null; spend: number | null }) {
  const ratio = (n: number | null, d: number | null) => n === null || d === null || d === 0 ? null : n / d;
  return { ctr: ratio(row.clicks, row.impressions), playsPerImpression: ratio(row.plays, row.impressions), cpc: ratio(row.spend, row.clicks), cpp: ratio(row.spend, row.plays) };
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const crcTable = Array.from({ length: 256 }, (_, n) => { let crc = n; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zipManifest(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65558) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65558 || end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw new Error("Invalid ZIP directory");
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) throw new Error("ZIP64 is unsupported");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Multi-disk ZIP is unsupported");
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const directoryStart = offset;
  if (!count || count > AD_REPORT_LIMITS.files || count !== view.getUint16(end + 8, true) || offset + directorySize !== end) throw new Error("Invalid ZIP count/size or unsupported ZIP64");
  const manifest = new Map<string, { size: number; crc: number; method: number; dataOffset: number; compressed: number }>();
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  const extraFields = (start: number, length: number) => {
    const end = start + length;
    while (start < end) {
      if (start + 4 > end) throw new Error("Invalid ZIP extra field");
      const id = view.getUint16(start, true), size = view.getUint16(start + 2, true);
      if (id === 1) throw new Error("ZIP64 is unsupported");
      start += 4 + size;
      if (start > end) throw new Error("Invalid ZIP extra field");
    }
  };
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true), local = view.getUint32(offset + 42, true);
    if (flags & ~0x080e || ![0, 8].includes(method) || view.getUint16(offset + 34, true) || offset + 46 + nameLength + extra + comment > end || local + 30 > directoryStart || view.getUint32(local, true) !== 0x04034b50) throw new Error("Encrypted/unsupported/invalid ZIP entry");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    safeName(name);
    if (!name.toLowerCase().endsWith(".csv")) throw new Error("ZIP may contain CSV files only");
    if (names.has(name.toLowerCase())) throw new Error("Duplicate ZIP entry");
    names.add(name.toLowerCase()); expanded += size;
    if (size > AD_REPORT_LIMITS.csvBytes || expanded > AD_REPORT_LIMITS.expandedBytes || size > Math.max(1024, compressed * 200)) throw new Error("ZIP size/count/compression ratio limit exceeded");
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    if (local + 30 + localNameLength + localExtra + compressed > directoryStart || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags || new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || (method === 0 && size !== compressed)) throw new Error("ZIP local/central metadata mismatch");
    extraFields(offset + 46 + nameLength, extra);
    extraFields(local + 30 + localNameLength, localExtra);
    const crc = view.getUint32(offset + 16, true);
    for (const [position, expected] of [[14, crc], [18, compressed], [22, size]]) {
      const actual = view.getUint32(local + position, true);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) throw new Error("ZIP local/central metadata mismatch");
    }
    const dataOffset = local + 30 + localNameLength + localExtra;
    ranges.push([local, dataOffset + compressed]);
    manifest.set(name, { size, crc, method, dataOffset, compressed });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) throw new Error("Invalid ZIP directory length");
  ranges.sort(([a], [b]) => a - b);
  if (ranges.some(([start], i) => i > 0 && start < ranges[i - 1][1])) throw new Error("Overlapping ZIP entries");
  return manifest;
}

/** Extract exactly the validated slices; never let a second ZIP parser choose a directory. */
function extractZip(bytes: Uint8Array): Record<string, Uint8Array> {
  const manifest = zipManifest(bytes);
  const sources: Record<string, Uint8Array> = Object.create(null);
  for (const [name, entry] of manifest) {
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
    let output: Uint8Array;
    if (entry.method === 0) output = compressed;
    else {
      try {
        // The native inflater enforces this bound while producing output, before a
        // forged size can cause an oversized allocation or a truncated prefix.
        const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size), chunkSize: Math.max(64, Math.min(16384, entry.size)), info: true }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== compressed.length) throw new Error("Trailing compressed data");
        output = result.buffer;
      } catch { throw new Error("ZIP DEFLATE output exceeds declared size or compressed data is invalid"); }
    }
    if (output.length !== entry.size || crc32(output) !== entry.crc) throw new Error("ZIP checksum/expanded-size mismatch");
    sources[name] = output;
  }
  return sources;
}
function safeName(name: string) {
  if (name.length > 500 || /[\x00-\x1f\\:]/.test(name) || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("Unsafe ZIP or CSV filename");
}
function identity(file: Pick<AdReportFile, "grain" | "entityType" | "cohort">, row: AdReportRow) { return JSON.stringify([file.grain, file.entityType, file.cohort, row.date, row.campaignId, row.adId]); }

/** Strict RFC4180-style CSV parser. Lines identify physical source lines, including quoted newlines. */
export function parseAdCsv(bytes: Uint8Array): { values: string[]; sourceLine: number }[] {
  if (bytes.length > AD_REPORT_LIMITS.csvBytes) throw new Error("CSV size limit exceeded");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); } catch { throw new Error("CSV must be valid UTF-8"); }
  if (text.includes("\0")) throw new Error("CSV contains NUL");
  const rows: { values: string[]; sourceLine: number }[] = [];
  let values: string[] = [], field = "", quoted = false, closed = false, line = 1, sourceLine = 1;
  const cell = () => { if (field.length > AD_REPORT_LIMITS.cellChars) throw new Error("CSV cell limit exceeded"); values.push(field); field = ""; closed = false; };
  const row = () => { cell(); if (values.some((value) => value !== "")) rows.push({ values, sourceLine }); values = []; sourceLine = line + 1; if (rows.length > AD_REPORT_LIMITS.rows + 1) throw new Error("CSV row limit exceeded"); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else { field += char; if (char === "\n") line++; } }
    else if (char === '"') { if (field || closed) throw new Error(`Malformed CSV quote at line ${line}`); quoted = true; }
    else if (char === ",") cell();
    else if (char === "\n" || char === "\r") { row(); if (char === "\r" && text[i + 1] === "\n") i++; line++; }
    else { if (closed) throw new Error(`Unexpected text after CSV quote at line ${line}`); field += char; }
    if (field.length > AD_REPORT_LIMITS.cellChars || values.length > 100) throw new Error("CSV cell/column limit exceeded");
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field || values.length || closed) row();
  return rows;
}
function numeric(value: string, label: string, count = false, percent = false): number | null {
  const clean = value.trim();
  if (["", "-", "—"].includes(clean)) return null;
  const percentage = clean.endsWith("%");
  const numberText = percentage ? clean.slice(0, -1) : clean;
  if (percentage && !percent) throw new Error(`Unexpected percentage in ${label}`);
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(numberText)) throw new Error(`Invalid ${label}`);
  const result = Number(numberText.replaceAll(",", "") + (percentage ? "e-2" : ""));
  if (!Number.isFinite(result) || result < 0 || (count && !Number.isSafeInteger(result))) throw new Error(`Invalid ${label}`);
  return result;
}
function dailyFile(name: string, bytes: Uint8Array, context: AdReportContext): AdReportFile | null {
  const base = name.split("/").at(-1)!;
  const match = /^Romanum_Daily_v1_(Campaigns|Ads)_(AllUsers|NewUsers|ReturningUsers|7DResurrected|30DResurrected)\.csv$/.exec(base);
  if (!match) return null;
  const parsed = parseAdCsv(bytes);
  if (!parsed.length || JSON.stringify(parsed[0].values) !== JSON.stringify(CANONICAL_DAILY_HEADER)) throw new Error("Unexpected Romanum canonical daily v1 header");
  const entityType = match[1] === "Campaigns" ? "campaign" : "ad";
  const rows = parsed.slice(1).map(({ values, sourceLine }) => {
    if (values.length !== CANONICAL_DAILY_HEADER.length) throw new Error(`CSV column count mismatch at line ${sourceLine}`);
    const raw = Object.fromEntries(CANONICAL_DAILY_HEADER.map((key, index) => [key, values[index]]));
    const date = dateSchema.parse(raw.date);
    if (!context.periodStart || !context.periodEnd || date < context.periodStart || date > context.periodEnd) throw new Error("Daily rows require a declared period containing their dates");
    if (!raw.campaignId.trim() || (entityType === "ad" ? !raw.adId.trim() : raw.adId.trim() || raw.adName.trim())) throw new Error("Daily entity identity mismatch");
    const metrics = { impressions: numeric(raw.impressions, "impressions", true), clicks: numeric(raw.clicks, "clicks", true), plays: numeric(raw.plays, "plays", true), spend: numeric(raw.spend, "spend") };
    return { ...metrics, sourceLine, date, campaignId: raw.campaignId.trim(), campaignName: raw.campaignName, adId: entityType === "ad" ? raw.adId.trim() : null, adName: entityType === "ad" ? raw.adName : null, paymentType: raw.paymentType.trim() || null, reported: { ctr: numeric(raw.reportedCtr, "reportedCtr"), playRate: numeric(raw.reportedPlayRate, "reportedPlayRate"), cpc: numeric(raw.reportedCpc, "reportedCpc"), cpp: numeric(raw.reportedCpp, "reportedCpp") }, calculated: calculateAdMetrics(metrics), raw };
  });
  return { name, sha256: sha256(bytes), grain: "daily", cohort: match[2] as AdReportCohort, entityType, rows };
}

// Native aggregate schema is restricted to the supplied, byte-verified Roblox export.
function aggregateFile(name: string, bytes: Uint8Array, context: AdReportContext): AdReportFile {
  const match = /^Roblox_(Campaigns|Ads)_(AllUsers|NewUsers|ReturningUsers|7DResurrected|30DResurrected)_Aggregated_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/.exec(name.split("/").at(-1)!);
  if (!match) throw new Error("Unexpected or unsupported Roblox aggregate filename/schema");
  const start = dateSchema.parse(match[3]), end = dateSchema.parse(match[4]);
  if (start > end || (context.periodStart !== null && context.periodStart !== start) || (context.periodEnd !== null && context.periodEnd !== end)) throw new Error("Declared report period differs from aggregate filename");
  context.periodStart = start; context.periodEnd = end;
  const entityType = match[1] === "Campaigns" ? "campaign" : "ad";
  const identityHeader = entityType === "campaign" ? ["Campaign Name", "Campaign ID", "Universe ID", "Start Date", "End Date", "Budget Type", "Budget", "Objective", "Audience"] : ["Campaign Name", "Campaign ID", "Universe ID", "Ad Set Name", "Ad Set ID", "Ad Name", "Ad ID", "Ad Format", "Objective", "Audience"];
  const metricHeader = ["Impressions", "CPM", "Clicks", "CTR", "CPC", "Plays", "Play Rate", "CPP", "Playtime (Hours)", "Robux Revenue", ...(match[2] === "AllUsers" ? ["USD Revenue"] : []), "Spent", "Payment Method"];
  const header = [...identityHeader, ...metricHeader];
  const parsed = parseAdCsv(bytes);
  if (!parsed.length || JSON.stringify(parsed[0].values) !== JSON.stringify(header)) throw new Error(`Unexpected Roblox aggregate header in ${name}`);
  const rows = parsed.slice(1).map(({ values, sourceLine }) => {
    if (values.length !== header.length) throw new Error(`CSV column count mismatch in ${name}:${sourceLine}`);
    const raw = Object.fromEntries(header.map((key, index) => [key, values[index]]));
    if (!raw["Campaign ID"].trim() || (entityType === "ad" && !raw["Ad ID"].trim())) throw new Error(`Missing entity ID in ${name}:${sourceLine}`);
    // Validate all numeric source columns, even when they are only retained in raw.
    for (const key of ["CPM", "Playtime (Hours)", "Robux Revenue", ...(match[2] === "AllUsers" ? ["USD Revenue"] : []), ...(entityType === "campaign" ? ["Budget"] : [])]) numeric(raw[key], key);
    const metrics = { impressions: numeric(raw.Impressions, "Impressions", true), clicks: numeric(raw.Clicks, "Clicks", true), plays: numeric(raw.Plays, "Plays", true), spend: numeric(raw.Spent, "Spent") };
    const rate = (key: string) => { const value = numeric(raw[key], key, false, true); return value === null ? null : raw[key].trim().endsWith("%") ? value : Number(`${value}e-2`); };
    return { ...metrics, sourceLine, date: null, campaignId: raw["Campaign ID"].trim(), campaignName: raw["Campaign Name"], adId: entityType === "ad" ? raw["Ad ID"].trim() : null, adName: entityType === "ad" ? raw["Ad Name"] : null, paymentType: raw["Payment Method"].trim() || null, reported: { ctr: rate("CTR"), playRate: rate("Play Rate"), cpc: numeric(raw.CPC, "CPC"), cpp: numeric(raw.CPP, "CPP") }, calculated: calculateAdMetrics(metrics), raw };
  });
  return { name, sha256: sha256(bytes), grain: "aggregate", cohort: match[2] as AdReportCohort, entityType, rows };
}

export function importAdReports(input: { name: string; bytes: Uint8Array }, inputContext: AdReportContext): AdReportBundle {
  const context = validateAdReportContext(inputContext);
  safeName(input.name);
  if (!input.bytes.length || input.bytes.length > AD_REPORT_LIMITS.uploadBytes) throw new Error("Upload size limit exceeded or empty upload");
  let sources: Record<string, Uint8Array>;
  if (input.name.toLowerCase().endsWith(".zip")) {
    sources = extractZip(input.bytes);
  } else if (input.name.toLowerCase().endsWith(".csv")) sources = { [input.name]: input.bytes };
  else throw new Error("Only CSV or ZIP uploads are supported");
  const warnings: string[] = [];
  const files = Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => dailyFile(name, bytes, context) ?? aggregateFile(name, bytes, context));
  const observations = new Map<string, AdReportRow>();
  for (const file of files) {
    file.rows = file.rows.filter((row) => {
      const key = identity(file, row), previous = observations.get(key);
      if (previous) {
        if (JSON.stringify({ ...previous, sourceLine: 0 }) !== JSON.stringify({ ...row, sourceLine: 0 })) throw new Error(`Conflicting duplicate observation in ${file.name}:${row.sourceLine}`);
        warnings.push(`Duplicate observation skipped: ${file.name}:${row.sourceLine}`); return false;
      }
      observations.set(key, row); return true;
    });
    if (!file.rows.length) warnings.push(`No reported rows for ${file.entityType}/${file.cohort} (${file.name}); absence is not zero.`);
    for (const row of file.rows) if (row.clicks !== null && row.plays !== null && row.plays > row.clicks) warnings.push(`Plays exceed clicks at ${file.name}:${row.sourceLine}; keep reported counts and confirm attribution.`);
  }
  if (!context.attributionWindow) warnings.push("Attribution window is unknown; confirm it before interpreting plays or comparing reports.");
  if (!context.currency) warnings.push("Currency/spend unit is unknown; payment type alone does not establish currency.");
  warnings.push("Cohorts overlap and are not additive. Campaign summaries and ad rows are separate views; do not sum them together.");
  const grains = new Set(files.map((file) => file.grain));
  const uniqueWarnings = [...new Set(warnings)];
  const boundedWarnings = uniqueWarnings.length > 1000 ? [...uniqueWarnings.slice(0, 995), `${uniqueWarnings.length - 999} additional row warnings omitted; inspect source rows.`, ...uniqueWarnings.slice(-4)] : uniqueWarnings;
  return validateAdReportBundle({ version: 1, format: grains.size > 1 ? "mixed" : grains.has("daily") ? "romanum-daily-v1" : "roblox-aggregate-v1", sha256: sha256(input.bytes), context, files, warnings: boundedWarnings });
}
