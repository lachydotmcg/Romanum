import evidence from "./model-rating-evidence.json" with { type: "json" };
import type { PublicModel } from "../../lib/models/types.ts";

export type Band = 1 | 2 | 3 | 4 | 5;
export type ModelProfile = {
  scores: { intelligence: Band | null; coding: Band | null; speed: Band | null; value: Band | null };
  evidence?: (typeof evidence)[keyof typeof evidence];
  referenceCostUsd?: number;
  speedSource?: string;
};

export const ARENA_SOURCE = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";
export const ARENA_LICENSE = "https://creativecommons.org/licenses/by/4.0/";
// Published provider USD/1M rates, checked 2026-10-03. These are reference-workload inputs,
// not wallet prices, credit estimates or a replacement for the server's billing catalog.
const referenceRates: Record<keyof typeof evidence, { input: number; output: number }> = {
  "gpt-6-luna": { input: .1, output: .5 }, "gpt-6.1-sol": { input: 2, output: 10 }, "gpt-6-astra": { input: 10, output: 50 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 }, "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 }, "claude-fable-5-1": { input: 10, output: 50 },
};
const cohort = Object.values(evidence);
const range = (axis: "intelligence" | "coding") => [Math.min(...cohort.map(row => row[axis].rating)), Math.max(...cohort.map(row => row[axis].rating))] as const;
const intelligenceRange = range("intelligence"), codingRange = range("coding");
export function coarseBand(value: number, minimum: number, maximum: number): Band | null {
  if (![value, minimum, maximum].every(Number.isFinite) || maximum <= minimum) return null;
  return Math.round(1 + 4 * Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))) as Band;
}
const quality = (row: (typeof cohort)[number]) => {
  const intelligence = coarseBand(row.intelligence.rating, ...intelligenceRange), coding = coarseBand(row.coding.rating, ...codingRange);
  return intelligence === null || coding === null ? null : (intelligence + coding) / 2;
};
const cost = (rates: { input: number; output: number }) => rates.input * .01 + rates.output * .002; // 10k uncached input + 2k total output
const valueReference = Object.entries(evidence).flatMap(([id, row]) => {
  const band = quality(row); return band === null ? [] : [Math.log(band / cost(referenceRates[id as keyof typeof evidence]))];
});
const valueRange = [Math.min(...valueReference), Math.max(...valueReference)] as const;

/** Dated, approximate catalog-cohort profiles. No live measurements or version aliases are inferred. */
export function estimatedModelProfile(model: Pick<PublicModel, "id" | "rates">): ModelProfile | undefined {
  if (model.id === "deepseek-flash" || model.id === "deepseek-v4-pro") {
    return { scores: { intelligence: null, coding: null, speed: null, value: null } };
  }
  if (!Object.hasOwn(evidence, model.id)) return undefined;
  const id = model.id as keyof typeof evidence, row = evidence[id], rates = referenceRates[id], qualityBand = quality(row);
  const ratesMatch = model.rates.input === rates.input && model.rates.output === rates.output;
  return {
    scores: { intelligence: coarseBand(row.intelligence.rating, ...intelligenceRange), coding: coarseBand(row.coding.rating, ...codingRange),
      speed: row.speed as Band, value: ratesMatch && qualityBand !== null ? coarseBand(Math.log(qualityBand / cost(rates)), ...valueRange) : null },
    evidence: row, referenceCostUsd: ratesMatch ? cost(rates) : undefined,
    speedSource: model.id.startsWith("gpt-") ? "https://developers.openai.com/api/docs/guides/model-selection" : "https://platform.claude.com/docs/en/models/overview",
  };
}
