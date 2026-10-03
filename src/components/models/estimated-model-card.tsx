import { ARENA_LICENSE, ARENA_SOURCE, type ModelProfile } from "./model-ratings.ts";

const axes = ["intelligence", "coding", "speed", "value"] as const;
const labels = { intelligence: "Intelligence", coding: "Coding", speed: "Speed", value: "Value" };
const readable = (score: number | null) => score === null ? "unavailable" : `${score} of 5`;

/** Decorative Auto illustration. It supplies no rating, route decision or performance data. */
export function AutoModelRange() {
  return <div>
    <p className="mb-1 flex justify-between text-[10px] text-fg-muted"><span>Illustrative capability range</span><span>1–5</span></p>
    <svg viewBox="0 0 200 166" role="img" aria-label="Illustrative Auto capability range: Intelligence, Coding, Speed and Value can span 1 to 5. No model score or observed routing performance is shown." className="w-full text-fg-muted">
      <path d="M100 28 152 80 100 132 48 80Z M100 69.6 89.6 80 100 90.4 110.4 80Z" fill="currentColor" fillOpacity=".08" fillRule="evenodd" />
      {[1, 2, 3, 4, 5].map(level => <path key={level} d={`M100 ${80 - level * 10.4} ${100 + level * 10.4} 80 100 ${80 + level * 10.4} ${100 - level * 10.4} 80Z`} fill="none" stroke="currentColor" strokeOpacity={level === 5 ? ".3" : ".14"} />)}
      <path d="M100 28V132M48 80H152" stroke="currentColor" strokeOpacity=".12" />
      <polygon aria-hidden="true" className="motion-reduce:hidden" points="100,38.4 131.2,80 100,111.2 58.4,80" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="1.25">
        <animate attributeName="points" values="100,38.4 131.2,80 100,111.2 58.4,80;100,59.2 152,80 100,100.8 68.8,80;100,28 120.8,80 100,132 79.2,80;100,38.4 131.2,80 100,111.2 58.4,80" dur="8s" repeatCount="indefinite" />
      </polygon>
      <g fill="currentColor" fontSize="10" fontFamily="inherit">
        <text x="100" y="10" textAnchor="middle">Intelligence</text><text x="100" y="23" textAnchor="middle">1–5</text>
        <text x="160" y="76">Coding</text><text x="176" y="90" textAnchor="middle">1–5</text>
        <text x="100" y="148" textAnchor="middle">Value</text><text x="100" y="162" textAnchor="middle">1–5</text>
        <text x="40" y="76" textAnchor="end">Speed</text><text x="24" y="90" textAnchor="middle">1–5</text>
      </g>
    </svg>
  </div>;
}

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
  if (!profile.evidence) return <p>Source version unmatched to this model alias.</p>;
  const { intelligence, coding } = profile.evidence;
  return <div className="space-y-1 break-words">
    <p>Five bands within seven matched models.</p>
    <p><a href={ARENA_SOURCE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Arena text preferences</a> (human preference proxy): {intelligence.model_name}, {intelligence.leaderboard_publish_date}.</p>
    <p>Coding: Arena web-development preference proxy, {coding.model_name}, {coding.leaderboard_publish_date}.</p>
    <p><a href={profile.speedSource} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Speed: provider positioning</a>, estimated tier.</p>
    <p>Value: estimated quality/cost, using average quality band per provider dollar for 10k uncached input + 2k output tokens, on a log scale.</p>
    <p>Published settings differ from Romanum: OpenAI medium; Claude model-default effort.</p>
    <p>Arena · <a href={ARENA_LICENSE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">CC BY 4.0</a> · adapted into coarse bands.</p>
  </div>;
}
