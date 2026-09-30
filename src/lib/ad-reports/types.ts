export type AdReportCohort = "AllUsers" | "NewUsers" | "ReturningUsers" | "7DResurrected" | "30DResurrected";
export type AdReportGrain = "aggregate" | "daily";
export type AdReportEntityType = "campaign" | "ad";
/** Romanum's explicit daily template; no native Roblox daily export is assumed. */
export const CANONICAL_DAILY_HEADER = ["date", "campaignId", "campaignName", "adId", "adName", "universeId", "objective", "adFormat", "impressions", "clicks", "plays", "spend", "paymentType", "reportedCtr", "reportedPlayRate", "reportedCpc", "reportedCpp"] as const;
export const CANONICAL_DAILY_CSV = `${CANONICAL_DAILY_HEADER.join(",")}\r\n`;
export interface AdReportContext {
  periodStart: string | null;
  periodEnd: string | null;
  timezone: string | null;
  attributionWindow: string | null;
  placement: string | null;
  audience: string | null;
  /** Currency/unit is explicitly supplied by the owner; Ad Credit does not establish USD. */
  currency: string | null;
}
export interface AdReportMetrics {
  impressions: number | null;
  clicks: number | null;
  plays: number | null;
  spend: number | null;
}
export interface AdReportCalculated {
  /** Paid ad clicks / ad impressions, as a fraction. Never discovery PTR. */
  ctr: number | null;
  playsPerImpression: number | null;
  cpc: number | null;
  cpp: number | null;
}
export interface AdReportRow extends AdReportMetrics {
  sourceLine: number;
  date: string | null;
  campaignId: string;
  campaignName: string;
  adId: string | null;
  adName: string | null;
  paymentType: string | null;
  reported: { ctr: number | null; playRate: number | null; cpc: number | null; cpp: number | null };
  calculated: AdReportCalculated;
  raw: Record<string, string>;
}
export interface AdReportFile {
  name: string;
  sha256: string;
  grain: AdReportGrain;
  cohort: AdReportCohort;
  entityType: AdReportEntityType;
  rows: AdReportRow[];
}
export interface AdReportBundle {
  version: 1;
  format: "roblox-aggregate-v1" | "romanum-daily-v1" | "mixed";
  sha256: string;
  context: AdReportContext;
  files: AdReportFile[];
  warnings: string[];
}
export interface AdReportSelection {
  grain: AdReportGrain;
  cohort: AdReportCohort;
  entityType: AdReportEntityType;
  campaignId?: string;
  adId?: string;
  dateStart?: string;
  dateEnd?: string;
}
export interface AdReportSummary extends AdReportMetrics {
  selection: AdReportSelection;
  rowCount: number;
  calculated: AdReportCalculated;
  currency: string | null;
  /** Number of missing cells, by metric. Incomplete sums remain null. */
  missing: Record<keyof AdReportMetrics, number>;
  sources: { name: string; sha256: string; sourceLine: number }[];
  warnings: string[];
}
