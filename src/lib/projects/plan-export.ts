import type { AssetPlan } from "./plans.ts";

// Export user/model text as literal Markdown, not executable HTML or tracking images.
const literal = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
export function planMarkdown(plan: AssetPlan): string {
  const lines = [`# ${literal(plan.title)}`, "", `${plan.kind === "ui" ? "UI" : "Thumbnail"} · Written plan`, "", `Project brief version: ${plan.projectRevision}`, `Saved: ${plan.createdAt}`, "", "## Creative brief", "", literal(plan.brief.goal), "", "### Gameplay promise", "", literal(plan.brief.truthfulContent), "", "### Visual direction", "", literal(plan.brief.visualDirection)];
  if (plan.brief.avoid.length) lines.push("", "### Avoid", "", ...plan.brief.avoid.map((item) => `- ${literal(item)}`));
  for (const concept of plan.concepts) {
    lines.push("", `## ${literal(concept.title)}`, "", "### Creative hypothesis", "", literal(concept.hypothesis), "", "### Composition and prompt", "", literal(concept.prompt));
    if (concept.assets.length) lines.push("", "### Assets");
    for (const asset of concept.assets) lines.push("", `#### ${literal(asset.label)} (${asset.size})`, "", literal(asset.prompt));
  }
  lines.push("", "## Project context", "");
  for (const [label, value] of [["Game", plan.projectContext.game], ["Core loop", plan.projectContext.gameplay], ["Audience", plan.projectContext.audience], ["Visual style", plan.projectContext.artDirection]]) {
    if (value) lines.push(`### ${label}`, "", literal(value), "");
  }
  if (plan.projectContext.constraints.length) lines.push("### Constraints", "", ...plan.projectContext.constraints.map((item) => `- ${literal(item)}`), "");
  return lines.join("\n");
}
