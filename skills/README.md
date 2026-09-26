# Romanum skills

Portable Roblox research and design guides. Romanum's assistant and MCP read these same files.

| Area | Skill | Use it for |
| --- | --- | --- |
| Research | [Genre analysis](romanum-genre-analysis/SKILL.md) | Public evidence, patterns and competition |
| Design | [Game design](romanum-game-design/SKILL.md) | Audience briefs, existing-game research, core loops and prototypes |
| Design | [Player onboarding](romanum-player-onboarding/SKILL.md) | First-session learning and measured iteration |
| Creative | [Thumbnail design](romanum-thumbnail-design/SKILL.md) | Concepts, generation briefs and experiment design |

## Use in an agent

Copy a complete skill folder, including its `LICENSE`, into the skill directory supported by your agent, preserving its `SKILL.md` filename. Ask the agent to use the guide for the relevant task. These are instructions, not executable integrations: they do not install Roblox tools, provide data or grant permission to spend credits.

For live public data, connect the agent to [Romanum MCP](../docs/mcp.md). In Romanum, `load_skill` accepts the folder name; registered skills also have a `romanum://skills/<folder-name>` resource.

## Licence

You can apply these skills to commercial games and client work. Selling the guides, paid skill packs, or commercial services built from the skills requires separate permission. Each folder carries the [Romanum licence](../LICENSE); generated project outputs have a commercial-use exception.

## Contribute

Keep one focused capability per folder, concise YAML `name`/`description`, a `license` notice and a copy of the root `LICENSE`. Distinguish observations, creator interpretations and design hypotheses. Cite sources honestly, paraphrase rather than redistribute transcripts, and keep personal project notes out. New in-platform guides also need an entry in `src/lib/skill-catalog.ts` and skill/resource tests.
