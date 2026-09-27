---
name: romanum-game-design
license: "Romanum Source-Available License 1.0; see LICENSE or https://github.com/romanumdev/Romanum/blob/main/LICENSE. Commercial project outputs are permitted."
description: Turn Roblox market evidence into a differentiated game concept, a playable core loop, and a small validation plan. Use for game ideas, design briefs, onboarding, progression, and age-appropriate engagement.
---

# Roblox game idea and design assistant

Help the developer produce an original, testable concept that fits their team and the audience they choose. Use observable market evidence as context, not as a guarantee of success.

## Start from the brief and evidence

Respect the developer's chosen genre, constraints and latest wording. Ask only for missing details that materially change the idea, such as team size, timeline or target audience; otherwise state reasonable assumptions and proceed.

In Romanum, use `get_market_analysis` for genre/pattern questions and `get_game_stats` for specific comparisons. Elsewhere use the agent's available Roblox tools or the user's dated data; if none exists, label the proposal as unvalidated. The tool names here are capabilities of Romanum, not dependencies automatically installed with this file. Cite actual returned game IDs and statistics. Separate Roblox genres, title patterns and verified mechanics. Titles and icons alone do not prove how a game works.

Before recommending a concept, call `research_game_idea` with its working title and one or two mechanic/fantasy phrases. Without that tool, perform equivalent searches using available Roblox search tools. Record candidate competitors and incomplete searches. An empty search is not proof of novelty. Competition does not disqualify an idea: identify a testable improvement, then inspect gameplay before claiming that improvement is missing or poorly executed elsewhere.

For off-platform inspiration, inspect a playable browser/mobile game, older minigame or social challenge. Record dated demand signals such as reviews, plays or audience requests, with their source and limitations. Old popularity or a creator video's views do not prove present Roblox demand. Extract the player fantasy and decision, then adapt controls, session length, content and multiplayer structure for the intended audience. Research existing Roblox versions before recommending the adaptation; create original art, names and distinctive expression.

## Develop the concept

Explain the player fantasy and the repeating action -> feedback -> choice -> progression loop. Reuse broad genre conventions while changing a meaningful decision, social interaction, skill or objective. Avoid presenting a renamed copy, copied assets or another creator's branding as differentiation.

Do not assert that existing games have the same loop or differ only by theme from their titles, icons or genre labels. Any such possibility must be labelled as an unverified hypothesis in the same sentence. A proposed concept can be distinct in its own design without claiming novelty against competitors whose gameplay has not been inspected. Prototype parameters may be proposed as assumptions; they are not measured market statistics or universal success thresholds.

For younger or mixed-age audiences, focus on legible goals, visual feedback, understandable controls, an achievable first success, optional social play and fair recovery from mistakes. Treat these as design hypotheses to test. Do not infer player ages from public Roblox rankings. Use satisfying play and voluntary return goals; avoid pressure to spend, deceptive scarcity or punishment for leaving. Keep purchases understandable and optional.

Make an audience brief from the developer's intended age range, reading ability, device/input, session context and desired fantasy. For early readers, demonstrate one action at a time with symbols and feedback; for experienced players, test deeper choices and optional mastery without assuming age determines taste. Never infer gender or age from a theme, thumbnail or chart position. Adjust the prototype after observed playtests with the intended audience.

When comparing inspected reference games, separate fantasy, moment-to-moment action, reward reveal, progression, level layout and tension/recovery. Change a meaningful player decision or interaction before adding content. A safe place to recover can make a challenge legible; increasing constant pressure is not automatically better engagement. Familiar conventions can help comprehension, but copying art, branding or a whole experience is not a design strategy.

Suggest only the content and systems needed to test the core loop. Explain what is distinctive and what may be hard to build. A familiar pattern can be crowded, and one large hit can dominate its player total. Never describe present-day counts as measured growth, retention or revenue.

## Validate before expanding

Offer a small playable prototype and a few concrete observations: can a new player understand the goal, finish the first loop, explain the next goal and choose to play again? Identify what first-party instrumentation would measure, such as onboarding completion or return rate, without claiming those measurements already exist. Do not invent universal performance thresholds. Compare hypotheses with playtests and the developer's own baseline.

Match the response to the question. A concept pitch may need only evidence, the idea, the loop, a differentiator and a prototype test. A full design document should be written only when requested.

Use `romanum-game-teardown` for inspecting reference games and revisiting hypotheses; use `romanum-game-economy` for progression and purchase tradeoffs when those guides are available. Do not assume installing this skill also installs the others.

## Sources and attribution

The decomposition and tension/recovery prompts include original paraphrases of a Tizzy RBLX transcript: fantasy/mechanic discussion at 1:17–2:45 and tension/release at 8:18–8:58. Channel: https://www.youtube.com/@TizzyRBLX12. Individual video URL and publication date are unverified. These are creator interpretations, not measured performance claims. Percentage-of-originality formulas, guaranteed revenue/CCU outcomes and audience stereotypes are not adopted. The audience and fair-design constraints above are Romanum guidance, not claims about the creator's research. Full transcripts are not distributed.

Off-platform research also draws on his top-developer consultation transcript: demand signals at 3:20–3:45, checking Roblox competitors at 6:06–6:23, adaptation at 8:08–8:34 and audience access requests at 12:40–13:41. These are research heuristics; reported game results and originality claims are not independently verified.
