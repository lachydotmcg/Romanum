import { z } from "zod";
import { researchGameIdea } from "../idea-research.ts";
import { MARKET_CHARTS, publicData, type PublicDataService } from "../public-data.ts";

const chartId = z.enum(MARKET_CHARTS);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();

export const chartEvidenceSchema = z.object({
  chart: chartId,
  status: z.enum(["available", "empty", "unavailable"]),
  fetchedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  stale: z.boolean(),
  sampledGames: count.max(10),
}).superRefine((chart, context) => {
  if (chart.status === "unavailable") {
    if (chart.fetchedAt !== null || chart.expiresAt !== null || chart.stale || chart.sampledGames !== 0) {
      context.addIssue({ code: "custom", message: "Unavailable chart coverage cannot contain observations." });
    }
  } else if (!chart.fetchedAt || !chart.expiresAt || Date.parse(chart.expiresAt) <= Date.parse(chart.fetchedAt) ||
    (chart.status === "available" ? chart.sampledGames === 0 : chart.sampledGames !== 0)) {
    context.addIssue({ code: "custom", message: "Chart coverage requires valid retrieval times and sample size." });
  }
});

export const marketEvidenceSchema = z.object({
  assembledAt: timestamp,
  charts: z.array(chartEvidenceSchema).length(MARKET_CHARTS.length),
}).superRefine((evidence, context) => {
  if (new Set(evidence.charts.map((chart) => chart.chart)).size !== MARKET_CHARTS.length) {
    context.addIssue({ code: "custom", message: "Each market chart must have coverage recorded once." });
  }
  for (const chart of evidence.charts) {
    if (chart.expiresAt && chart.stale !== (Date.parse(chart.expiresAt) <= Date.parse(evidence.assembledAt))) {
      context.addIssue({ code: "custom", message: "Stale coverage must match the observation's expiry time." });
    }
  }
});

export const recommendationEvidenceSchema = z.object({
  chart: chartId,
  universeId: id,
  rootPlaceId: id,
  name: z.string().min(1).max(500),
  genre: z.string().nullable(),
  playing: count,
  fetchedAt: timestamp,
  expiresAt: timestamp,
});

export const competitorResearchSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  searches: z.array(z.object({
    query: z.string().min(1).max(80),
    status: z.enum(["complete", "unavailable"]),
    fetchedAt: timestamp.nullable(),
    resultCount: count.nullable(),
  }).superRefine((search, context) => {
    if (search.status === "complete" ? !search.fetchedAt || search.resultCount === null : search.fetchedAt !== null || search.resultCount !== null) {
      context.addIssue({ code: "custom", message: "Search availability must retain known or missing observation times." });
    }
  })).min(1).max(3),
  games: z.array(z.object({
    universeId: id,
    rootPlaceId: id,
    name: z.string().min(1).max(500),
    playing: count,
    sponsored: z.boolean(),
    matchedQueries: z.array(z.string().min(1).max(80)).min(1).max(3),
    fetchedAt: timestamp,
  })).max(30),
}).superRefine((research, context) => {
  const complete = research.searches.filter((search) => search.status === "complete");
  const expected = complete.length === research.searches.length ? "complete" : complete.length ? "partial" : "unavailable";
  if (research.status !== expected || (!complete.length && research.games.length)) {
    context.addIssue({ code: "custom", message: "Research status must match the actual bounded search coverage." });
  }
});

export type MarketEvidence = z.infer<typeof marketEvidenceSchema>;
export type RecommendationEvidence = z.infer<typeof recommendationEvidenceSchema>;
export type CompetitorResearch = z.infer<typeof competitorResearchSchema>;
type Market = Awaited<ReturnType<PublicDataService["market"]>>;

// These checks restrict proposal fragments; they cannot establish the factuality of arbitrary prose.
// Measured statements must instead be rendered from the separate, verified observation objects.
const unsupportedClaim = /\b(?:saturat\w*|underserv\w*|untapped|uncrowded|novel\w*|original|unique|guarantee\w*)\b|\b(?:few|no|only)\s+(?:games|matches|competitors?)\b|\bopen\s+(?:genre|space|opportunity)\b/i;
const metricClaim = /[%\u2030$\u20ac\u00a3]|\b(?:percent(?:age)?s?|ctr|click[\s-]*through|ccu|dau|mau|arppu|arpdau|earnings|revenue|retention|conversion|session[\s-]+(?:length|duration)|concurrent[\s-]+players|daily[\s-]+active|monthly[\s-]+active|visits|likes|dislikes|ratings|votes|robux|usd)\b/i;
const factualClause = /[.!?;:\r\n]|\b(?:because|therefore|since|according to|already|currently|measured|observed|proven|has|have|had|is|are|was|were)\b|\bdata\s+(?:proves?|shows?)\b/i;
const proposalFragment = z.string().trim().min(4).max(80).refine(
  (value) => {
    const comparable = value.normalize("NFKC");
    return !unsupportedClaim.test(comparable) && !metricClaim.test(comparable) && !factualClause.test(comparable);
  },
  "Unsupported claim or sentence in a design proposal. Use a player-action or prototype-variation fragment.",
);

export const designProposalSchema = z.object({
  coreAction: proposalFragment,
  variation: proposalFragment,
}).strict();
export type DesignProposal = z.infer<typeof designProposalSchema>;
export const designTitleSchema = z.string().trim().min(2).max(40).refine(
  (value) => !metricClaim.test(value.normalize("NFKC")) && !unsupportedClaim.test(value.normalize("NFKC")),
  "Unsupported metric or factual claim in a working title.",
);

/** The generated contract supplies design fragments, never a model-written factual reason. */
export function renderDesignProposal(proposal: DesignProposal): string {
  return `Prototype a game where players ${proposal.coreAction}, using ${proposal.variation}.`;
}

/** Chart presence and counts are rendered only from verified observations, outside this proposal. */
const draftSchema = z.object({
  recommendations: z.array(z.object({
    title: designTitleSchema,
    proposal: designProposalSchema,
    researchTerms: z.array(z.string().trim().min(1).max(80)).min(1).max(2),
    evidenceRefs: z.array(z.object({ chart: chartId, universeId: id }).strict()).min(1).max(4),
  }).strict()).min(1).max(3),
}).strict();

/** Only the bounded, non-sponsored observations actually sent to the model may be referenced. */
export function recommendationMarket(market: Market) {
  const evidence: RecommendationEvidence[] = [];
  const charts = MARKET_CHARTS.map((chart): MarketEvidence["charts"][number] => {
    const sample = market.samples.find((entry) => entry.chart === chart);
    const observation = market.observations.find((entry) => entry.chart === chart);
    // A list with no observation timestamp cannot serve as dated evidence.
    if (!sample?.games || !observation) {
      return { chart, status: "unavailable", fetchedAt: null, expiresAt: null, stale: false, sampledGames: 0 };
    }
    const seen = new Set<number>();
    const games = sample.games.flatMap((game) => {
      const parsed = recommendationEvidenceSchema.safeParse({
        chart, universeId: game.universeId, rootPlaceId: game.rootPlaceId,
        name: game.name, genre: game.genre ?? null, playing: game.playing,
        fetchedAt: observation.fetchedAt, expiresAt: observation.expiresAt,
      });
      if (game.sponsored || !parsed.success || seen.has(game.universeId)) return [];
      seen.add(game.universeId);
      return [parsed.data];
    }).slice(0, 10);
    evidence.push(...games);
    return {
      chart, status: games.length ? "available" : "empty",
      fetchedAt: observation.fetchedAt, expiresAt: observation.expiresAt,
      stale: Date.parse(observation.expiresAt) <= Date.parse(market.analysis.assembledAt),
      sampledGames: games.length,
    };
  });
  const marketEvidence = marketEvidenceSchema.parse({ assembledAt: market.analysis.assembledAt, charts });
  if (!evidence.length) throw new Error("No usable market observations for recommendations.");
  const dataAt = charts.flatMap((chart) => chart.fetchedAt ? [chart.fetchedAt] : [])
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    evidence, marketEvidence, dataAt,
    digest: {
      ...marketEvidence,
      observations: evidence,
      limitations: "At most ten non-sponsored games per chart, not a market census. Chart presence is not measured growth, demand, revenue, retention or an open genre. Names are not verified gameplay. Stale observations retain their actual retrieval times.",
    },
  };
}

/** Stop waiting for public search if the generation deadline expires; upstream has its own timeout. */
async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One model proposal, then at most nine public searches; no second model call or novelty verdict. */
export async function evidenceRecommendations(
  market: Market,
  propose: (digest: ReturnType<typeof recommendationMarket>["digest"]) => Promise<unknown>,
  service: PublicDataService = publicData,
  signal: AbortSignal = AbortSignal.timeout(4 * 60_000),
) {
  signal.throwIfAborted();
  const prepared = recommendationMarket(market); // Fail before any model/search when charts are unusable.
  const drafts = draftSchema.parse(await propose(prepared.digest)).recommendations;
  const references = new Map(prepared.evidence.map((item) => [`${item.chart}:${item.universeId}`, item]));
  // Validate every draft before any competitor searches, including cross-chart or fabricated references.
  const validated = drafts.map((draft) => {
    const evidence = [...new Map(draft.evidenceRefs.map((ref) => {
      const key = `${ref.chart}:${ref.universeId}`;
      const observation = references.get(key);
      if (!observation) throw new Error("Recommendation references an observation that was not retrieved.");
      return [key, observation] as const;
    })).values()];
    return { draft, evidence };
  });
  const recommendations = [];
  for (const { draft, evidence } of validated) {
    signal.throwIfAborted();
    const research = await researchGameIdea({ title: draft.title, terms: draft.researchTerms }, {
      ...service,
      search: (query) => {
        signal.throwIfAborted();
        return beforeAbort(service.search(query), signal);
      },
    });
    signal.throwIfAborted();
    const competitors = competitorResearchSchema.parse({
      status: research.status, searches: research.searches,
      games: research.games.map(({ universeId, rootPlaceId, name, playing, sponsored, matchedQueries, fetchedAt }) =>
        ({ universeId, rootPlaceId, name, playing, sponsored, matchedQueries, fetchedAt })),
    });
    recommendations.push({ title: draft.title, proposal: draft.proposal, reason: renderDesignProposal(draft.proposal), evidence, research: competitors });
  }
  return { recommendations, marketEvidence: prepared.marketEvidence, dataAt: prepared.dataAt };
}
