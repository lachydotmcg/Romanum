# Romanum — Complete Product Outline and Roadmap

This is the canonical product outline supplied by the product owner. **Stage 1 is the current development priority.** The later stages describe direction, not authorization to implement them. Current repository capabilities are recorded separately in [implementation status](docs/roadmap.md).

**Scoped authorization, 2026-09-26:** the owner requested a start on MCP. This authorizes a public, read-only endpoint over the existing data and guides, plus its connection page and verification. It does not advance the rest of Stage 3 or authorize the later roadmap. The original outline below is preserved.

**Local Stage 2 authorization, 2026-09-26:** after reviewing the next steps, the owner authorized trying the historical data pipeline locally: PostgreSQL storage, a repeatable collector, shared app/MCP queries and graphs of actual collected observations. Public hosting is still deferred to the owner. This starts a bounded Stage 2 implementation without authorizing the later roadmap.

**Game discovery authorization, 2026-09-26:** the owner approved starting game search and individual game pages, with icons, current public statistics and real recorded history using the shared data services. Keep these inside Analytics. Collector operations, richer comparisons and private connections remain separate follow-up work.

**Owner direction, 2026-09-27:** a future chats page, credits, model routing and a UI marketplace are recorded in [section 26](#26-owner-direction-2026-09-27). These describe direction, not authorization.

## 1. Product vision

Romanum is intended to become a central development platform for Roblox creators.

The core idea is to connect:

**Real Roblox data → analysis → ideas → creation tools → development → measurement**

Rather than rebuilding tools that already exist, Romanum should integrate existing AI models, image generation, Roblox tooling, MCP servers, Blender tooling, and other services into one coherent development environment.

Romanum should eventually allow an AI agent to understand what is happening across Roblox, understand the developer's own game, assist with decisions, create assets and code, interact with development tools, and evaluate the resulting performance.

- **Name:** Romanum
- **Inspiration:** Forum Romanum — a place where people, thinkers, and ideas came together.
- **Slogan:** Create without limits.

## 2. Core principles

### Free analytics

Analytics should not be hidden behind a subscription.

Developers should be able to explore the available Romanum dataset without paying simply to see charts or historical information.

### Free MCP access

Romanum should expose its available data and appropriate capabilities through MCP.

A developer who already pays for ChatGPT, Claude, Codex, or another compatible agent should be able to connect that agent to Romanum rather than being forced to pay for Romanum's AI interface.

### Paid integrated harness

The SaaS component comes primarily from Romanum's hosted creation environment and compute-intensive capabilities.

Examples eventually include:

- Hosted AI agents
- Image generation
- Thumbnail generation
- UI generation
- Sound generation
- Managed development workflows
- Tool orchestration
- Potential hosted compute or generation credits

### Data-grounded AI

Romanum's AI should use actual Romanum data rather than giving generic Roblox development advice.

It should clearly distinguish measured information from interpretation.

### Integrate rather than reinvent

If a reliable capability already exists, Romanum should integrate it where practical.

Romanum's value should increasingly come from making these systems work together with shared project context.

### Open source where practical

Components such as the MCP integration, schemas, skills, SDKs, local tooling, or other appropriate infrastructure can eventually be open sourced.

## 3. Stage 1 — Website foundation

**THIS IS THE CURRENT DEVELOPMENT PRIORITY.**

Do not attempt to implement the later roadmap during Stage 1.

The immediate objective is establishing Romanum's identity, application shell, navigation, and analytics interface.

### Visual direction

- Dark mode
- Clean
- Modern
- Professional
- Simple
- Flat design
- No gradients
- No fake dashboard data

Do not invent additional visual directions that have not been specified.

## 4. Romanum branding

Create the Romanum branding as SVG assets rather than relying on generated raster images.

### Wordmark

The primary wordmark reads:

**Romanum**

The first "o" should be represented by the tilted square concept discussed for the brand.

It should be slightly modified/original rather than simply embedding Roblox's official logo asset.

Typography should remain simple and professional.

### Compact branding

The collapsed navigation should display:

**Ro**

with the same tilted-square "o".

### Sidebar animation

When the sidebar expands, the branding should smoothly transition from:

**Ro → Romanum**

The intention is for the rest of the word to reveal/extend naturally rather than replacing one unrelated logo with another.

## 5. Stage 1 application shell

### Sidebar

Romanum uses a thin vertical sidebar.

It can expand to expose additional information.

### Collapsed

At the top:

**Ro**

Navigation currently contains only:

- Analytics SVG icon

At the bottom:

- Guest/profile icon
- Get MCP icon/action

### Expanded

The sidebar smoothly widens.

The top branding becomes:

**Romanum**

Navigation becomes:

- Analytics icon + Analytics

Bottom area exposes:

- Guest
- Get MCP

The sidebar should remain simple because additional sections will be introduced as Romanum develops.

## 6. Analytics page

Analytics is Romanum's first major section.

For Stage 1, focus on constructing the interface that will eventually display real data.

Do not fabricate statistics for the demo.

This means no invented:

- CCU
- Visits
- Revenue
- Retention
- Growth percentages
- Game rankings
- Historical graphs
- AI findings
- Market trends

Empty states are preferable to fake information.

The architecture should make it straightforward to connect real data later.

## 7. AI analytics interface

An AI interaction area should sit prominently toward the top of the analytics experience.

Its eventual purpose is to let developers ask questions directly about the available data.

Examples of the intended capability include questions conceptually like:

- Why has this game been growing?
- What changed in this genre recently?
- Compare these experiences.
- What mechanics appear frequently among games matching these criteria?
- Explain this statistic.
- Give me game ideas based on these trends.

These are product examples, not responses that should be faked in Stage 1.

Eventually the AI should be able to reference the actual underlying observations used in its answer.

## 8. Romanum data platform

This comes after the initial UI foundation.

Romanum needs a proper data layer for collecting and storing Roblox information that it can legitimately access.

Potential categories include:

- Experience metadata
- Player counts
- Likes/ratings where available
- Updates
- Genre/category information
- Discoverability information
- Historical observations collected by Romanum
- Other legitimately accessible platform information

Romanum should preserve historical observations over time where useful.

This database becomes one of the foundations of the platform.

## 9. Connected developer analytics

Romanum should eventually allow developers to connect experiences they own.

Where Roblox exposes authenticated analytics, Romanum can provide considerably deeper analysis for those experiences.

Publicly observable information and privately authorised developer analytics must remain clearly separated.

Romanum should never imply that it knows private metrics for another developer's game when it does not.

**Connected-data requirements, 2026-09-26:** developers should be able to connect API credentials for supported data from experiences they are authorised to manage, then analyse that data privately. Provide an optional, reversible setting for contributing data to improve Romanum, with clear disclosure of what is collected and how it is used. Plan data retention and deletion requests before collecting private data, and publish a reviewed privacy policy before real release. API availability and permissions must be verified before promising specific metrics. This records future scope, not authorization to implement private ingestion now. See the [connected-data plan](docs/connected-data.md) for proposed defaults and delivery gates.

## 10. MCP server

Romanum should expose a free MCP interface.

This allows external AI agents to interact with Romanum.

Eventually an agent could perform operations conceptually similar to:

- Search experiences
- Retrieve an experience
- Query historical statistics
- Compare experiences
- Query trends
- Retrieve connected-game analytics
- Retrieve Romanum skills
- Understand metric definitions
- Access supported Romanum tools

MCP should use the same underlying services and data as the website rather than becoming an entirely separate implementation.

### Stage 1 MCP experience

For now, the website only needs the Get MCP entry point.

Do not pretend that MCP is operational until the server exists.

## 11. Romanum integrated AI

Romanum can eventually provide its own integrated agent experience.

This is different from free MCP access.

External AI:

**User's AI → Romanum MCP → Romanum data/tools**

Integrated experience:

**Romanum agent → Romanum context → connected tools → creation/development workflows**

The integrated agent should eventually maintain context about a developer's project rather than behaving like an isolated chatbot.

## 12. Romanum projects

Developers should eventually be able to create or connect a project representing their Roblox game.

A Romanum project can become shared context containing things such as:

- Game information
- Analytics
- Existing assets
- UI conventions
- Art direction
- Development conventions
- Game mechanics
- Current objectives
- Generated assets
- Experiments
- Relevant Romanum skills

This context can then be used across Romanum's AI tools.

## 13. Thumbnail generation

Romanum should eventually provide thumbnail generation.

The differentiator is that generation can be informed by real platform and connected-game data rather than functioning as a generic image generator.

Potential workflow:

**Analyse → form creative hypothesis → generate → developer reviews → use/test → measure → analyse again**

The system should not simply copy successful thumbnails.

The goal is to use evidence to help determine what should be tested.

Romanum's integrated AI should also be capable of invoking thumbnail generation itself.

## 14. UI generation

Romanum should eventually provide UI generation.

The integrated AI should be able to invoke it directly.

Long term, this should move beyond simply generating pictures of interfaces.

The goal is eventually to produce assets and/or structures that can actually be used in Roblox development workflows.

Project context should inform generated interfaces so developers do not continually have to explain their game's visual identity.

## 15. Other generation capabilities

Romanum may later integrate additional generation capabilities.

Potential examples:

- General game artwork
- Icons
- Game assets
- Sound generation
- Other creative tooling

These should be integrations where sensible rather than requiring Romanum to develop foundational generation models.

## 16. Skills system

Romanum should eventually provide reusable development skills.

These should contain practical guidance grounded where possible in:

- Professional game-development knowledge
- Roblox documentation
- Professional advice
- Romanum's available data
- Evidence gathered from a developer's own game

Potential skill areas could eventually cover subjects such as game design, analytics interpretation, onboarding, retention, UI, thumbnails, monetisation, testing, or other development disciplines.

Romanum's own agent and external agents connected through MCP should eventually be capable of using these skills.

## 17. Roblox Studio integration

Long term, Romanum should connect analysis and planning to actual implementation.

Through appropriate Roblox Studio/MCP tooling, an authorised agent could eventually:

- Understand a project's structure
- Inspect scripts
- Create/edit code
- Work with UI
- Add generated assets
- Run appropriate tests
- Assist with debugging

This turns Romanum from an analytics assistant into part of the development workflow.

Publishing or destructive actions should eventually have appropriate user controls.

## 18. Blender integration

Blender MCP or equivalent tooling could eventually allow Romanum agents to participate in 3D asset workflows.

The intention is not to rebuild Blender.

Romanum provides the project context, orchestration, AI reasoning, and connection between analytics/design requirements and the existing creation tool.

## 19. Computer-use and broader tooling

Romanum's harness may eventually support computer-use capabilities where appropriate.

The broader goal is that an agent can move between the tools required to create a game rather than ending at a text response.

The long-term workflow could therefore span:

**Research → planning → UI → images → 3D → code → Studio → testing → analytics**

## 20. Full game creation — long-term direction

The eventual ambition is for Romanum's integrated agent to coordinate enough tools that it can assist with increasingly large portions of game creation.

At the extreme end, this could mean an agent can:

1. Analyse what is happening across Roblox.
2. Research a proposed game.
3. Help develop the concept.
4. Establish a project.
5. Generate appropriate UI and artwork.
6. Create or modify Roblox code.
7. Use 3D tooling where required.
8. Work through Studio.
9. Test the implementation.
10. Assist the developer through launch.
11. Observe real results.
12. Use those results to inform subsequent development.

This is a long-term direction, not a Stage 1 promise.

## 21. Developer profiles

Developers should eventually be able to create accounts and profiles.

Profiles may allow developers to link games they have created or contributed to.

This can eventually form the foundation for Romanum's community and professional features.

## 22. Hiring and contractors

A later Romanum stage may introduce developer discovery and hiring.

Developers could:

- Show projects they have worked on
- Indicate that they are looking for work
- Find people with particular skills
- Look for contractors
- Potentially verify contributions to projects

This should come considerably later than the core analytics/development platform.

## 23. Broad development stages

### Stage 1 — Foundation

**Current priority.**

- Romanum SVG branding
- Dark application shell
- Collapsible sidebar
- Smooth branding/sidebar animations
- Analytics navigation
- Guest state
- Get MCP entry point
- Analytics page structure
- AI analytics interface structure
- Proper empty states
- No fabricated data

### Stage 2 — Real analytics

- Data acquisition pipeline
- Database
- Historical observations
- Real experience search
- Real charts/statistics
- Comparison tools
- Data provenance/freshness
- Initial AI analysis grounded in retrieved data

### Stage 3 — Open AI access

- Romanum MCP server
- Documented MCP tools
- External-agent access
- Skills infrastructure
- MCP/SDK documentation
- Appropriate open-source components

### Stage 4 — Connected creators

- Authentication
- Developer profiles
- Link owned experiences
- Authorised private analytics
- Romanum projects
- Persistent project context
- Deeper AI analysis

### Stage 5 — Creation

- Thumbnail generation
- UI generation
- Other image generation
- Potential sound generation
- AI invocation of generation tools
- Project-aware asset generation
- Analytics-informed creative workflows

### Stage 6 — Development harness

- Integrated Romanum agent
- Model/tool orchestration
- Roblox Studio integration
- Code workflows
- Testing
- Blender integration
- Computer-use where appropriate
- Permissions and approval controls

### Stage 7 — Closed-loop development

Connect the entire workflow:

**Observe → understand → propose → create → implement → test → measure → improve**

### Stage 8 — Developer ecosystem

- Rich developer profiles
- Linked/verified work
- Looking-for-work functionality
- Contractor discovery
- Collaboration features

## 24. Development organisation

Implementation should eventually be managed through:

### Trello

- Roadmap
- Current tasks
- Ownership
- Dependencies
- Status
- Acceptance criteria

### PROJECT.md

- Product vision
- Architecture
- Roadmap
- Product rules
- Terminology
- Major technical decisions

### AGENTS.md

- Instructions for coding agents
- Repository structure
- Development conventions
- Testing requirements
- Areas agents may modify
- Guardrails
- Task/commit expectations
- Documentation requirements

We will develop AGENTS.md properly once the repository and initial architecture actually exist rather than inventing conventions prematurely.

## 25. Instruction for the first implementation

**Build Stage 1 only.**

The remaining stages describe the direction the architecture should leave room for. They are not requests to create placeholder implementations for every future feature.

Do not fabricate analytics or populate the interface with pretend Roblox data.

Do not invent additional product features.

Do not make later roadmap features appear functional.

Prioritise the Romanum identity, SVG wordmark, dark application shell, collapsible sidebar, smooth interactions, Analytics page, AI interface shell, Guest state, and Get MCP entry point.

The result should feel like the beginning of Romanum rather than a fake finished SaaS dashboard.

## 26. Owner direction, 2026-09-27

Recorded as the owner stated it. This is direction for later stages, not authorization to build it now. In the owner's words: "I genuinely just want this to be a hub for everything."

### Chats page

Chats should get their own page instead of sitting at the top of Analytics, likely once Romanum can make games and other things. The reference is ChatGPT:
- A new chat starts with the composer centred.
- The composer moves to the bottom once the conversation starts.
- Past chats are listed in the sidebar.

### Credits

- Credits are Romanum's currency. Users can pay a monthly subscription or buy credits outright.
- Every user, including guests, gets a small number of free credits.
- The principles in section 2 still apply: analytics and MCP access stay free.

### Model routing

- Use base models where they suit the task, potentially routing each request deterministically to a model chosen by its suspected difficulty.
- Analytical requests should only ever need DeepSeek or GPT-6 Luna.
- Coding can still route to DeepSeek and Luna to an extent, but Sol or Opus is the likely recommendation for coding later.
- The details will be settled when this is built. Model names are as the owner gave them; check availability and pricing at that point.

### UI marketplace

- With data collection turned on, the AI can ask whether a UI it made would be useful to add to the marketplace, or prompt the user to decide.
- The AI can pick premade UIs from the marketplace, including existing free UIs that weren't AI-generated.
- What sets Romanum's UI tool apart: the AI doesn't have to generate every UI. It can find an existing one instead, which saves the user credits.
