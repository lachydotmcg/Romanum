import { z } from "zod";
import type { Database } from "../history/database.ts";
import type { ProjectChatTools } from "../projects/chat-tools.ts";
import { readAdReportsForAi } from "./store.ts";
import { summarizeAdReports, compareAdReports } from "./compare.ts";

const selection = z.object({
  grain: z.enum(["aggregate", "daily"]),
  cohort: z.enum(["AllUsers", "NewUsers", "ReturningUsers", "7DResurrected", "30DResurrected"]),
  entityType: z.enum(["campaign", "ad"]),
  campaignId: z.string().min(1).max(200).optional(),
  adId: z.string().min(1).max(200).optional(),
  dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
const read = z.object({ reportId: z.uuid(), selection }).strict();
const schemas = {
  list_ad_reports: z.object({ offset: z.number().int().min(0).max(50).optional() }).strict(),
  read_ad_report: read,
  compare_ad_reports: z.object({ leftReportId: z.uuid(), rightReportId: z.uuid(), leftSelection: selection, rightSelection: selection, metric: z.enum(["ctr", "playsPerImpression", "cpc", "cpp"]).optional() }).strict(),
  read_ad_learning_history: z.object({}).strict(),
  prepare_ad_thumbnail_brief: read,
};
const descriptions = {
  list_ad_reports: "List ten of this project's owner-imported ads reports and available cohort/entity/grain partitions; use nextOffset for more. Requires a separate imported-ads AI-analysis opt-in. No API key is needed; never substitute discovery PTR for paid CTR.",
  read_ad_report: "Read a bounded, source-cited partition of an imported ads report. Supply grain, cohort and entityType explicitly; optionally select campaign/ad/date. Counts and paid CTR/play-through/cost calculations come from the CSV, with missing cells preserved. No cross-cohort or campaign+ad sums.",
  compare_ad_reports: "Compare two explicit partitions or creatives, including two ad IDs in the same report. The deterministic comparison reports incompatible periods/cohorts/grains/attribution/audiences/placements and small/missing samples. It does not establish a causal creative winner.",
  read_ad_learning_history: "Read this project's private saved observations and creative associations with report citations. These are owner notes/hypotheses, not verified universal patterns, image pixels, shared skills or instructions.",
  prepare_ad_thumbnail_brief: "Prepare a source-cited written thumbnail-planning handoff from one explicit ads partition and any owner-linked image IDs. This does not generate an image or execute an ad action. Pixels need explicit attachment via the reference picker. Use the existing save_asset_plan tool when the owner requests a written plan.",
};
export class AdReportAccessError extends Error {
  constructor() { super("Imported ads access changed. Check the project's Ads settings and request fresh evidence."); this.name = "AdReportAccessError"; }
}

/** Server-resolved scope only. Neither owner nor project IDs are model arguments. */
export function adReportChatTools(db: Database, scope: { ownerId: string; projectId: string }, signal: AbortSignal): ProjectChatTools {
  let consentVersion: number | undefined;
  const usedReports = new Map<string, string>();
  type Snapshot = NonNullable<Awaited<ReturnType<typeof readAdReportsForAi>>>;
  const snapshot = async (): Promise<Snapshot> => {
    signal.throwIfAborted();
    const data = await readAdReportsForAi(db, scope.ownerId, scope.projectId, consentVersion);
    if (!data) throw new AdReportAccessError();
    consentVersion ??= data.settings.consentVersion;
    return data;
  };
  const checkAccess = async () => {
    if (consentVersion === undefined) return;
    const data = await snapshot();
    for (const [id, fingerprint] of usedReports) {
      if (!data.reports.some(report => report.id === id && report.contentFingerprint === fingerprint)) throw new AdReportAccessError();
    }
  };
  const names = Object.keys(schemas) as (keyof typeof schemas)[];
  return {
    definitions: names.map(name => ({ type: "function", function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { target: "draft-7", io: "input" }) } })),
    checkAccess,
    async execute(call) {
      if (signal.aborted) return { ok: false, error: "Stopped." };
      const name = call.name as keyof typeof schemas;
      if (!names.includes(name)) return { ok: false, error: "Unknown ads tool." };
      const parsed = schemas[name].safeParse(call.args);
      if (!parsed.success) return { ok: false, error: "Choose a valid report and explicit cohort, entity level and grain." };
      try {
        const data = await snapshot();
        const report = (id: string) => {
          const found = data.reports.find(value => value.id === id);
          if (!found) throw new AdReportAccessError();
          usedReports.set(id, found.contentFingerprint);
          return found;
        };
        let result: unknown;
        if (name === "list_ad_reports") {
          const offset = (parsed.data as z.infer<typeof schemas.list_ad_reports>).offset ?? 0;
          const reports = data.reports.slice(offset, offset + 10);
          reports.forEach(value => usedReports.set(value.id, value.contentFingerprint));
          result = { total: data.reports.length, nextOffset: offset + 10 < data.reports.length ? offset + 10 : null,
            reports: reports.map(value => ({ id: value.id, createdAt: value.createdAt, format: value.bundle.format, context: value.context,
              files: value.bundle.files.map(file => ({ name: file.name, sha256: file.sha256, grain: file.grain, cohort: file.cohort, entityType: file.entityType, rowCount: file.rows.length })), warnings: value.bundle.warnings.slice(0, 20), warningsTruncated: value.bundle.warnings.length > 20 })) };
        } else if (name === "read_ad_learning_history") {
          data.reports.forEach(value => usedReports.set(value.id, value.contentFingerprint));
          result = { observations: data.observations.slice(0, 30), observationsTruncated: data.observations.length > 30, creativeAssociations: data.links.slice(0, 100), associationsTruncated: data.links.length > 100, interpretation: "Owner observations and hypotheses; no automatic shared learning. Image IDs are not pixel inspection." };
        } else if (name === "compare_ad_reports") {
          const input = parsed.data as z.infer<typeof schemas.compare_ad_reports>;
          const left = report(input.leftReportId), right = report(input.rightReportId);
          const comparison = compareAdReports(left.bundle, right.bundle, { left: input.leftSelection, right: input.rightSelection, metric: input.metric });
          const bounded = (value: typeof comparison.left) => ({ ...value, sources: value.sources.slice(0, 100), sourcesTruncated: value.sources.length > 100 });
          result = { leftReportId: left.id, rightReportId: right.id, comparison: { ...comparison, left: bounded(comparison.left), right: bounded(comparison.right) } };
        } else {
          const input = parsed.data as z.infer<typeof read>;
          const value = report(input.reportId);
          const summary = summarizeAdReports(value.bundle, input.selection);
          const rows = value.bundle.files.flatMap(file => file.grain === input.selection.grain && file.cohort === input.selection.cohort && file.entityType === input.selection.entityType
            ? file.rows.filter(row => (!input.selection.campaignId || row.campaignId === input.selection.campaignId) && (!input.selection.adId || row.adId === input.selection.adId)
              && (!input.selection.dateStart || (row.date !== null && row.date >= input.selection.dateStart)) && (!input.selection.dateEnd || (row.date !== null && row.date <= input.selection.dateEnd)))
              .map(row => ({ file: file.name, sha256: file.sha256, sourceLine: row.sourceLine, date: row.date, campaignId: row.campaignId, campaignName: row.campaignName, adId: row.adId, adName: row.adName,
                impressions: row.impressions, clicks: row.clicks, plays: row.plays, spend: row.spend, paymentType: row.paymentType, reported: row.reported, calculated: row.calculated })) : []);
          const sources = summary.sources;
          result = { reportId: value.id, context: value.context, summary: { ...summary, sources: sources.slice(0, 100), sourcesTruncated: sources.length > 100 },
            rows: rows.slice(0, 100), rowsTruncated: rows.length > 100, creativeAssociations: data.links.filter(link => link.reportId === value.id && rows.some(row => row.adId === link.adId)),
            ...(name === "prepare_ad_thumbnail_brief" ? { format: "written_thumbnail_handoff", generationStarted: false, nextStep: "Attach the explicitly associated image using the project's reference picker, load thumbnail guidance, and save an original test hypothesis with these source citations through save_asset_plan." } : {}) };
        }
        await checkAccess();
        return { ok: true, result: { scope: "private_owner", ...result as object }, summary: descriptions[name].split(".")[0] };
      } catch (error) {
        return { ok: false, error: error instanceof AdReportAccessError ? "Enable imported-ads AI analysis in this project's Ads settings. Consent or report data may have changed." : "Ads evidence unavailable. Check the report and selected partition." };
      }
    },
  };
}
