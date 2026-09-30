import type { AdReportBundle, AdReportCalculated, AdReportMetrics, AdReportRow, AdReportSelection, AdReportSummary } from "./types.ts";

const COHORTS = ["AllUsers", "NewUsers", "ReturningUsers", "7DResurrected", "30DResurrected"];
function selectedRows(bundle: AdReportBundle, selection: AdReportSelection) {
  if (!selection || !["aggregate", "daily"].includes(selection.grain) || !["campaign", "ad"].includes(selection.entityType) || !COHORTS.includes(selection.cohort)) throw new Error("An explicit grain, entity type and cohort are required");
  if (selection.adId && selection.entityType !== "ad") throw new Error("adId requires ad entity selection");
  if (selection.grain === "aggregate" && (selection.dateStart || selection.dateEnd)) throw new Error("Aggregate reports cannot be filtered into daily observations");
  for (const date of [selection.dateStart, selection.dateEnd]) if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error("Invalid selected date");
  if (selection.dateStart && selection.dateEnd && selection.dateStart > selection.dateEnd) throw new Error("Invalid selected date range");
  return bundle.files.filter((file) => file.grain === selection.grain && file.entityType === selection.entityType && file.cohort === selection.cohort).flatMap((file) => file.rows.filter((row) => (!selection.campaignId || row.campaignId === selection.campaignId) && (!selection.adId || row.adId === selection.adId) && (!selection.dateStart || (row.date !== null && row.date >= selection.dateStart)) && (!selection.dateEnd || (row.date !== null && row.date <= selection.dateEnd))).map((row) => ({ row, file })));
}
function calculated(metrics: AdReportMetrics): AdReportCalculated {
  const ratio = (n: number | null, d: number | null) => n === null || d === null || d === 0 ? null : n / d;
  return { ctr: ratio(metrics.clicks, metrics.impressions), playsPerImpression: ratio(metrics.plays, metrics.impressions), cpc: ratio(metrics.spend, metrics.clicks), cpp: ratio(metrics.spend, metrics.plays) };
}
/** Sum exactly one grain/entity/cohort. Null cells make that entire metric incomplete. */
export function summarizeAdReports(bundle: AdReportBundle, selection: AdReportSelection): AdReportSummary {
  const entries = selectedRows(bundle, selection);
  const missing = { impressions: 0, clicks: 0, plays: 0, spend: 0 };
  const metrics: AdReportMetrics = { impressions: null, clicks: null, plays: null, spend: null };
  for (const metric of Object.keys(missing) as (keyof AdReportMetrics)[]) {
    missing[metric] = entries.filter(({ row }) => row[metric] === null).length;
    if (entries.length && !missing[metric]) {
      const sum = entries.reduce((total, { row }) => total + row[metric]!, 0);
      if (!Number.isFinite(sum) || (metric !== "spend" && !Number.isSafeInteger(sum))) throw new Error("Metric sum exceeds safe numeric range");
      metrics[metric] = metric === "spend" ? Number(sum.toFixed(10)) : sum;
    }
  }
  const warnings: string[] = [];
  const paymentTypes = new Set(entries.map(({ row }) => row.paymentType));
  if (entries.length && (paymentTypes.size !== 1 || paymentTypes.has(null))) {
    metrics.spend = null;
    warnings.push("Payment method is mixed or unknown; spend, CPC and CPP cannot be combined across unspecified units.");
  }
  if (!entries.length) warnings.push("Selection has no observations; absence is not zero.");
  if (Object.values(missing).some((count) => count > 0)) warnings.push("Missing source metrics remain null; ad rows do not fill campaign summary gaps.");
  if (!bundle.context.currency) warnings.push("Spend unit/currency is unknown; CPC and CPP are expressed only in the source's unspecified unit.");
  if (!bundle.context.attributionWindow) warnings.push("Attribution window is unknown.");
  if ((metrics.impressions !== null && metrics.impressions < 1000) || (metrics.clicks !== null && metrics.clicks < 30) || (metrics.plays !== null && metrics.plays < 10)) warnings.push("Small sample: descriptive metrics alone do not establish a reliable winner.");
  if (entries.some(({ row }) => row.clicks !== null && row.plays !== null && row.plays > row.clicks)) warnings.push("Reported plays exceed clicks; plays/clicks is not treated as a conversion probability.");
  if (selection.grain === "daily") {
    const start = selection.dateStart ?? bundle.context.periodStart, end = selection.dateEnd ?? bundle.context.periodEnd;
    const dates = new Set(entries.map(({ row }) => row.date));
    if (start && end && dates.size < Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1) warnings.push("Daily coverage is incomplete; unreported dates are missing, not zero.");
    if (start && end) {
      const byEntity = new Map<string, Set<string>>();
      for (const { row } of entries) { const key = `${row.campaignId}/${row.adId ?? ""}`; const dates = byEntity.get(key) ?? new Set<string>(); dates.add(row.date!); byEntity.set(key, dates); }
      if ([...byEntity.values()].some((dates) => dates.size < Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1)) warnings.push("Daily coverage is incomplete for at least one selected entity; summaries contain observed rows only.");
    }
  }
  return { ...metrics, selection: { ...selection }, rowCount: entries.length, calculated: calculated(metrics), currency: bundle.context.currency, missing, sources: entries.map(({ file, row }) => ({ name: file.name, sha256: file.sha256, sourceLine: row.sourceLine })), warnings };
}
export interface AdReportComparisonOptions { left: AdReportSelection; right: AdReportSelection; metric?: keyof AdReportCalculated }
export interface AdReportComparison { comparable: boolean; reasons: string[]; warnings: string[]; left: AdReportSummary; right: AdReportSummary; delta: AdReportCalculated; winner: "left" | "right" | "tie" | null }
export function compareAdReports(leftBundle: AdReportBundle, rightBundle: AdReportBundle, options: AdReportComparisonOptions): AdReportComparison {
  const left = summarizeAdReports(leftBundle, options.left), right = summarizeAdReports(rightBundle, options.right);
  const metric = options.metric ?? "ctr";
  if (!["ctr", "playsPerImpression", "cpc", "cpp"].includes(metric)) throw new Error("Unknown comparison metric");
  const reasons: string[] = [], warnings = [...left.warnings, ...right.warnings];
  const cost = metric === "cpc" || metric === "cpp";
  for (const key of ["periodStart", "periodEnd", "timezone", "attributionWindow", "placement", "audience"] as const) {
    if (leftBundle.context[key] !== rightBundle.context[key]) reasons.push(`Report context differs: ${key}.`);
    if (leftBundle.context[key] === null || rightBundle.context[key] === null) reasons.push(`Report context is unknown: ${key}.`);
  }
  if (options.left.grain !== options.right.grain) reasons.push("Aggregate and daily grains cannot be compared directly.");
  if (options.left.cohort !== options.right.cohort) reasons.push("Cohorts differ; overlapping cohorts are not comparable or additive.");
  if (options.left.entityType !== options.right.entityType) reasons.push("Campaign summaries and ad rows are different entity grains.");
  if ((options.left.dateStart ?? leftBundle.context.periodStart) !== (options.right.dateStart ?? rightBundle.context.periodStart) || (options.left.dateEnd ?? leftBundle.context.periodEnd) !== (options.right.dateEnd ?? rightBundle.context.periodEnd)) reasons.push("Selected reporting periods differ.");
  if (cost && (!left.currency || !right.currency || left.currency !== right.currency)) reasons.push("Cost comparison requires the same known currency/spend unit.");
  const lRows = selectedRows(leftBundle, options.left).map(({ row }) => row), rRows = selectedRows(rightBundle, options.right).map(({ row }) => row);
  const aliases: Record<string, string> = { "Universe ID": "universeId", "Objective": "objective", "Ad Format": "adFormat" };
  const field = (rows: AdReportRow[], key: string, bundle: AdReportBundle) => new Set(rows.map((row) => key === "Payment Method" ? row.paymentType : (row.raw[key] ?? row.raw[aliases[key]])?.trim() || (key === "Audience" ? bundle.context.audience : null)));
  for (const key of ["Universe ID", "Objective", "Audience", ...(options.left.entityType === "ad" || options.right.entityType === "ad" ? ["Ad Format"] : []), ...(cost ? ["Payment Method"] : [])]) {
    const a = field(lRows, key, leftBundle), b = field(rRows, key, rightBundle);
    if (a.has(null) || b.has(null) || a.has("Unspecified") || b.has("Unspecified")) reasons.push(`Delivery context is unknown: ${key}.`);
    if (a.size !== 1 || b.size !== 1 || [...a][0] !== [...b][0]) reasons.push(`Delivery context differs or is mixed: ${key}.`);
  }
  if (!left.rowCount || !right.rowCount) reasons.push("Both selections require observations.");
  if (left.calculated[metric] === null || right.calculated[metric] === null) reasons.push(`Comparison metric is unavailable: ${metric}.`);
  const dailyIncomplete = warnings.some((warning) => warning.startsWith("Daily coverage is incomplete"));
  if (dailyIncomplete) reasons.push("Daily date coverage is incomplete; missing observations prevent a definitive comparison.");
  const small = warnings.some((warning) => warning.startsWith("Small sample"));
  if (small) warnings.push("No definitive winner is declared for small samples.");
  const comparable = reasons.length === 0;
  const delta: AdReportCalculated = { ctr: null, playsPerImpression: null, cpc: null, cpp: null };
  if (comparable) for (const key of Object.keys(delta) as (keyof AdReportCalculated)[]) {
    // Unspecified currency must never silently produce a cost delta.
    if ((key === "cpc" || key === "cpp") && (!left.currency || left.currency !== right.currency)) continue;
    const a = left.calculated[key], b = right.calculated[key];
    delta[key] = a === null || b === null ? null : b - a;
  }
  let winner: AdReportComparison["winner"] = null;
  if (comparable && !small) {
    const a = left.calculated[metric]!, b = right.calculated[metric]!;
    winner = a === b ? "tie" : (cost ? a < b : a > b) ? "left" : "right";
    warnings.push("Winner is a descriptive metric ranking, not proof of causal lift or statistical significance.");
  }
  return { comparable, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], left, right, delta, winner };
}
