import type { ModelQuote, PublicModel } from "../../lib/models/types.ts";
import { CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY, PRICING_POLICIES } from "../../lib/credits/pricing-policy.ts";

export type ModelEvaluation = {
  modelId: string;
  kind: "benchmark" | "fixture";
  scores: { reasoning: number; coding: number; speed: number; value: number };
  source: { title: string; url: string; measuredAt: string; methodology: string };
};

function validEvaluation(value: ModelEvaluation, allowFixture: boolean) {
  return !!value?.scores && !!value.source && typeof value.source.title === "string" && typeof value.source.methodology === "string" &&
    (value.kind === "benchmark" || (allowFixture && value.kind === "fixture")) &&
    Object.values(value.scores).length === 4 &&
    ["reasoning", "coding", "speed", "value"].every(axis => {
      const score = value.scores[axis as keyof ModelEvaluation["scores"]];
      return Number.isFinite(score) && score >= 0 && score <= 100;
    }) && !!value.source.title.trim() && !!value.source.methodology.trim() &&
    typeof value.source.measuredAt === "string" && Number.isFinite(Date.parse(value.source.measuredAt)) &&
    typeof value.source.url === "string" && /^https:\/\//.test(value.source.url);
}

/** Values must share a documented 0–100 evaluation scale. Fixtures are rejected by default. */
export function ModelStatDiamond({ evaluation, allowFixture = false }: { evaluation: ModelEvaluation; allowFixture?: boolean }) {
  if (!validEvaluation(evaluation, allowFixture)) return null;
  const { reasoning, coding, speed, value } = evaluation.scores;
  const points = `100,${78 - reasoning * .56} ${100 + coding * .56},78 100,${78 + value * .56} ${100 - speed * .56},78`;
  return <svg viewBox="0 0 200 160" role="img" aria-label={`Model evaluation: reasoning ${reasoning}, coding ${coding}, speed ${speed}, value ${value}, each out of 100`}
    className="w-full text-fg-muted">
    {[28, 56].map(radius => <path key={radius} d={`M100 ${78 - radius} ${100 + radius} 78 100 ${78 + radius} ${100 - radius} 78Z`} fill="none" stroke="currentColor" strokeOpacity=".22" />)}
    <path d="M100 22V134M44 78H156" stroke="currentColor" strokeOpacity=".15" />
    <polygon points={points} fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.5" />
    <g fill="currentColor" fontSize="10" fontFamily="inherit">
      <text x="100" y="12" textAnchor="middle">Reasoning</text>
      <text x="164" y="81">Coding</text>
      <text x="100" y="152" textAnchor="middle">Value</text>
      <text x="36" y="81" textAnchor="end">Speed</text>
    </g>
  </svg>;
}

const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
const creditAmount = (value: number) => new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 4 }).format(value);
// Qualitative task descriptions checked against the linked official model guides on 2026-10-03.
// They are not benchmark scores or a comparison scale across providers.
const USE_CASES: Record<string, string> = {
  "deepseek-flash": "Text, images and tool workflows.",
  "deepseek-v4-pro": "Text and tool workflows.",
  "gpt-6-luna": "Focused, high-volume tasks.",
  "gpt-6.1-sol": "Complex coding and professional work.",
  "gpt-6-astra": "Complex reasoning, coding and research.",
  "claude-haiku-4-5-20251001": "Quick everyday work.",
  "claude-sonnet-5-5": "Coding with speed in mind.",
  "claude-opus-5-5": "Long coding and knowledge workflows.",
  "claude-fable-5-1": "Demanding reasoning and long workflows.",
};

/** No price conversion or quality ranking is inferred in the browser. */
export function ModelPreview({ model, quote, evaluation }: { model: PublicModel; quote?: ModelQuote; evaluation?: ModelEvaluation }) {
  const ratings = evaluation?.modelId === model.id && validEvaluation(evaluation, false) ? evaluation : undefined;
  const prices = [model.rates.input, model.rates.output, model.rates.cacheRead];
  const validPrices = prices.every(value => Number.isFinite(value) && value >= 0);
  const validQuote = quote?.modelId === model.id && quote.rateCardVersion === model.rateCardVersion && Number.isFinite(quote.estimatedCredits) && quote.estimatedCredits >= 0 &&
    (quote.pricingPolicyVersion === undefined || quote.pricingPolicyVersion === LEGACY_PRICING_POLICY || quote.pricingPolicyVersion === CURRENT_PRICING_POLICY);
  const policy = validQuote ? quote!.pricingPolicyVersion ?? LEGACY_PRICING_POLICY : CURRENT_PRICING_POLICY;
  const strengths = [model.capabilities.text && "Text", model.capabilities.tools && "Tools", model.capabilities.images && "Images"].filter(Boolean);
  return <div className="space-y-3">
    {USE_CASES[model.id] && <p className="text-xs leading-5 text-fg-muted">{USE_CASES[model.id]}</p>}
    {ratings ? <ModelStatDiamond evaluation={ratings} /> : <div className="flex flex-wrap gap-1.5">
      {strengths.map(label => <span key={String(label)} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-fg-muted">{label}</span>)}
    </div>}
    {validQuote && <p className="text-xs text-fg">This call <span className="float-right">~{creditAmount(quote.estimatedCredits)} credits</span></p>}
    {validPrices && <div>
      <p className="mb-1.5 text-[10px] text-fg-muted">Provider USD / 1M tokens</p>
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div><dt className="text-fg-muted">Input</dt><dd className="mt-0.5 text-fg">{dollars(model.rates.input)}</dd></div>
        <div><dt className="text-fg-muted">Output</dt><dd className="mt-0.5 text-fg">{dollars(model.rates.output)}</dd></div>
        <div><dt className="text-fg-muted">Cache read</dt><dd className="mt-0.5 text-fg">{dollars(model.rates.cacheRead)}</dd></div>
      </dl>
      <p className="mt-2 text-[10px] text-fg-muted">Romanum AI: provider cost × {PRICING_POLICIES[policy].markup}.</p>
    </div>}
    <details className="text-[11px] text-fg-muted">
      <summary className="w-fit cursor-pointer rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70">Sources</summary>
      <div className="mt-2 space-y-1">
        <p><a href={model.sources.model} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Model guide</a> · <a href={model.sources.pricing} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Pricing</a></p>
        {Number.isFinite(Date.parse(model.checkedAt)) && <p>Rates: {new Date(model.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} · standard</p>}
        <p>Profile: 3 Oct 2026</p>
        {ratings && <><a href={ratings.source.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{ratings.source.title}</a><p>{ratings.source.methodology}</p><p>{ratings.source.measuredAt.slice(0, 10)}</p></>}
      </div>
    </details>
  </div>;
}
