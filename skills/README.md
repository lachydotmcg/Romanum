# Romanum skills

Portable Roblox research and design guides. Romanum's assistant and MCP read these same files.

| Area | Skill | Use it for |
| --- | --- | --- |
| Research | [Genre analysis](romanum-genre-analysis/SKILL.md) | Public evidence, patterns and competition |
| Research | [Game teardown](romanum-game-teardown/SKILL.md) | Observed gameplay, design hypotheses and follow-up checks |
| Design | [Game design](romanum-game-design/SKILL.md) | Audience briefs, existing-game research, core loops and prototypes |
| Design | [Game economy](romanum-game-economy/SKILL.md) | Progression balance, optional purchases and measured experiments |
| Design | [Player onboarding](romanum-player-onboarding/SKILL.md) | First-session learning and measured iteration |
| Creative | [Thumbnail design](romanum-thumbnail-design/SKILL.md) | Concepts, generation briefs and experiment design |
| Creative | [UI workflow](romanum-ui-workflow/SKILL.md) | Library reuse, visual review, separate assets and native Roblox UI |

## Use in an agent

Choose individual skills with the [Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add lachydotmcg/Romanum
```

Review the selected guides and licence before installing. The CLI is a separate third-party tool; see its documentation for agent support and telemetry options.

For manual installation, copy a complete skill folder, including its `LICENSE`, into your agent's skill directory and preserve the `SKILL.md` filename. Each folder includes a display name and example prompt for compatible agents. These instructions do not install tools, provide data or grant permission to spend credits.

For live public data, connect the agent to [Romanum MCP](../docs/mcp.md). In Romanum, `load_skill` accepts the folder name; registered skills also have a `romanum://skills/<folder-name>` resource.

## Licence

You can apply these skills to commercial games and client work. Selling the guides, paid skill packs, or commercial services built from the skills requires separate permission. Each folder carries the [Romanum licence](../LICENSE); generated project outputs have a commercial-use exception.

## Contribute

Keep one focused capability per folder, concise YAML `name`/`description`, a `license` notice and a copy of the root `LICENSE`. Distinguish observations, creator interpretations and design hypotheses. Cite sources honestly, paraphrase rather than redistribute transcripts, and keep personal project notes out. New in-platform guides also need an entry in `src/lib/skill-catalog.ts` and skill/resource tests.
