import { ARENA_LICENSE, ARENA_SOURCE, type ModelProfile } from "./model-ratings.ts";

const axes = ["intelligence", "coding", "speed", "value"] as const;
const labels = { intelligence: "Intelligence", coding: "Coding", speed: "Speed", value: "Value" };
const readable = (score: number | null) => score === null ? "unavailable" : `${score} of 5`;

export function EstimatedModelDiamond({ profile }: { profile: ModelProfile }) {
  if (!axes.every(axis => profile.scores[axis] === null || (Number.isInteger(profile.scores[axis]) && profile.scores[axis]! >= 1 && profile.scores[axis]! <= 5))) return null;
  if (!axes.some(axis => profile.scores[axis] !== null)) return null;
  const { intelligence, coding, speed, value } = profile.scores;
  const point = (axis: typeof axes[number], score: number) => {
    const radius = score * 10.4;
    return axis === "intelligence" ? [100, 80 - radius] : axis === "coding" ? [100 + radius, 80]
      : axis === "value" ? [100, 80 + radius] : [100 - radius, 80];
  };
  const complete = axes.every(axis => profile.scores[axis] !== null);
  return <div>
    <p className="mb-1 flex justify-between text-[10px] text-fg-muted"><span>Estimated</span><span>1–5</span></p>
    <svg viewBox="0 0 200 166" role="img" aria-label={`Estimated model profile: ${axes.map(axis => `${labels[axis]} ${readable(profile.scores[axis])}`).join(", ")}. Higher is better.`}
      className="w-full text-fg-muted">
      {[1, 2, 3, 4, 5].map(level => <path key={level} d={`M100 ${80 - level * 10.4} ${100 + level * 10.4} 80 100 ${80 + level * 10.4} ${100 - level * 10.4} 80Z`} fill="none" stroke="currentColor" strokeOpacity={level === 5 ? ".26" : ".12"} />)}
      <path d="M100 28V132M48 80H152" stroke="currentColor" strokeOpacity=".12" />
      {complete && <polygon points={["intelligence", "coding", "value", "speed"].map(axis => point(axis as typeof axes[number], profile.scores[axis as typeof axes[number]]!).join(",")).join(" ")} fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.5" />}
      {!complete && axes.map(axis => profile.scores[axis] === null ? null : <circle key={axis} cx={point(axis, profile.scores[axis]!)[0]} cy={point(axis, profile.scores[axis]!)[1]} r="2.5" fill="currentColor" />)}
      <g fill="currentColor" fontSize="10" fontFamily="inherit">
        <text x="100" y="10" textAnchor="middle">Intelligence</text><text x="100" y="23" textAnchor="middle">{intelligence ?? "—"}</text>
        <text x="160" y="76">Coding</text><text x="176" y="90" textAnchor="middle">{coding ?? "—"}</text>
        <text x="100" y="148" textAnchor="middle">Value</text><text x="100" y="162" textAnchor="middle">{value ?? "—"}</text>
        <text x="40" y="76" textAnchor="end">Speed</text><text x="24" y="90" textAnchor="middle">{speed ?? "—"}</text>
      </g>
    </svg>
  </div>;
}

export function EstimatedProfileSources({ profile }: { profile: ModelProfile }) {
  if (!profile.evidence) return <p>Benchmark version unmatched to this model alias.</p>;
  const { intelligence, coding } = profile.evidence;
  return <div className="space-y-1 break-words">
    <p>Five bands within seven matched models.</p>
    <p><a href={ARENA_SOURCE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Arena text preferences</a>: {intelligence.model_name}, {intelligence.leaderboard_publish_date}.</p>
    <p>Coding uses Arena web-development preferences: {coding.model_name}, {coding.leaderboard_publish_date}.</p>
    <p><a href={profile.speedSource} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Speed: provider positioning</a>, estimated tier.</p>
    <p>Value: average quality band per provider dollar for 10k uncached input + 2k output tokens{profile.referenceCostUsd !== undefined ? ` ($${profile.referenceCostUsd.toFixed(3)})` : ""}, on a log scale.</p>
    <p>Published test settings; Romanum uses OpenAI medium and Claude model-default effort.</p>
    <p>Arena · <a href={ARENA_LICENSE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">CC BY 4.0</a> · adapted into coarse bands.</p>
  </div>;
}
