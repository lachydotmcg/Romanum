# Email drafting and editing

Before drafting, revising, or reviewing an email, read [emaillanguage.md](./emaillanguage.md). Preserve the user's latest wording, voice, and factual status; make only the edits requested or needed for clarity and correctness.

# Product scope

- Read [PROJECT.md](./PROJECT.md) before product or architecture changes. It is the canonical product outline and roadmap.
- Stage 1 is the current priority. Later stages are direction, not authorization to implement or scaffold features. Follow the user's explicit task scope.
- Never fabricate analytics, rankings, historical graphs, AI findings or market trends. Use real observations or honest empty states.
- Keep the foundation dark, simple, professional and flat, with SVG branding and no gradients. Preserve the smooth `Ro` to `Romanum` sidebar reveal.
- Main navigation is Analytics and Your games. Your games belongs to the profile (`/profile`); the nav item is its shortcut because people rarely open a profile to find their games (owner decision, 2026-09-26). Keep it an honest empty state until games can be connected. Keep Skills hidden until requested; preserve its guides, SVG and internal assistant support for reuse.
- Assistant answers are short and plain by default, offering more detail rather than including it. After each answer a separate small model call predicts the next question, which the prompt bar offers and Tab accepts.
- The owner authorized the initial public, read-only MCP slice on 2026-09-26. Get MCP opens `/connect`; the server is `/mcp`. Keep its tools on the shared public data service. Do not imply a public deployment exists without verifying it.
- Analytics and MCP access are intended to be free; the paid product is the integrated creation environment and compute. Do not add data paywalls.
- Keep the roadmap and current implementation status distinct. Do not treat existing integrations as permission to expand later stages or invent repository conventions.
- On 2026-09-26 the owner also authorized local Stage 2 history work: PostgreSQL schema, collection, shared history queries and honest graphs. Hosting remains separate. Keep `.local/` data and credentials ignored and excluded from deployment bundles.
- Game search and individual game pages were also authorised on 2026-09-26. Keep them within Analytics, use the shared public service, and never imply viewing a game starts collecting its history.

# Frontend copy

- Use as few words as possible. Prefer clear labels, numbers and actions; omit redundant subtitles, helper paragraphs and promotional copy.
- Keep data caveats, implementation warnings, source-ingestion status and setup instructions in code comments or documentation, not on the dashboard or Skills index.
- Put longer explanations on a separate guide page or in the GitHub repository, reached through a short link.
- Preserve essential metric labels, accessible names and concise, actionable error states.
- Skills are selected automatically by the assistant. Do not add a public skill-mode selector.
- If the Skills section returns, use the custom Romanum Skills SVG rather than a generic book icon.
- Concise copy must not hide consent or privacy disclosures. Show the essential data use beside its control and link to details.

# Future connected data

- Read [docs/connected-data.md](docs/connected-data.md) before connected-game work. It is a plan, not an implemented capability or permission to expand the current public MCP slice.
- Keep service-required private analysis separate from optional platform-improvement use. Never route private observations, credentials or derived private reports into public tools, shared caches or skills.
- Implement consent enforcement and deletion across derived data before enabling optional contributions; a UI toggle alone is insufficient.

# MCP development

- Share schemas and handlers in `src/lib/public-tools.ts` with the integrated assistant; share observations and timestamps through `src/lib/public-data.ts`.
- Keep MCP independent of paid model calls. Read-only access to locally recorded history is now authorized; authentication/private analytics and write tools remain out of scope.
- Validate tool inputs, restrict guide/resource access to the catalog, and preserve host/origin checks and bounded requests. Put deployment requirements in `docs/mcp.md`.
- Run `npm test`, `npm run lint`, `npx tsc --noEmit` and `npm run build` for protocol/service changes. Use `npm run mcp:smoke` against a running local server to verify the official client and actual Roblox responses.
