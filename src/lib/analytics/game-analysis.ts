/** The game detail action asks the existing assistant to retrieve evidence, never to invent an audit. */
export function gameAnalysisPrompt(game: { name: string; universeId: number }, privateAnalytics = false): string {
  return `Analyse ${game.name.slice(0, 200)} (universe ${game.universeId}). Retrieve its current public stats and actual recorded player history before answering. ${privateAnalytics
    ? "This is my linked game. Use its authorized private daily metrics too; check the latest available dates and projected values."
    : "Use public data only. Do not infer private retention, revenue, acquisition or thumbnail CTR."} Give me a concise, actionable review: first the strongest measured signals and data gaps, then up to three prioritized changes I could test. For each test, explain the evidence, the hypothesis, the concrete change and what metric/time window would validate it. Separate measurements from interpretation. Do not claim a cause or improvement without evidence. If the data is insufficient, say what to collect next instead of inventing findings.`;
}
