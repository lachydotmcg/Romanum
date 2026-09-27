# Romanum

Create without limits.

A Roblox development platform with public game search, current statistics, recorded player history, an AI assistant and a free read-only MCP server.

- **[Browse the skills](https://github.com/romanumdev/romanum-skills)** — reusable research, game design, onboarding and thumbnail guides.
- **[Connect through MCP](docs/mcp.md)** — use the same public data from an external agent.

## Local development

Use Node.js 22.18 or newer (24 recommended).

```sh
git submodule update --init
npm install
npm run dev
```

Open http://localhost:3000. To collect public observations locally, run `npm run history:db` and `npm run history:watch` in separate terminals. Data stays under the ignored `.local/` directory. Collection lasts only while those processes run. Viewing a game does not enrol it in collection.

The integrated assistant uses `DEEPSEEK_API_KEY` in `.env.local`. Public analytics and MCP do not require a paid model. The assistant needs authentication and spending controls before public deployment.

### Chats and credits

Chats (`/chats`) are saved conversations with the same assistant. A message can carry up to three PNG, JPEG or WebP reference images, up to 5 MB each. The model can't see images; it gets their names, and image generation isn't connected yet, so thumbnail requests get a written concept. Chats and attachments are stored in the local database (`npm run history:db`; run `npm run history:migrate` after pulling new migrations).

Until sign-in exists, each browser is an anonymous guest identified by a random cookie. A new guest receives 50 welcome credits, shown beside Guest in the sidebar. One credit is worth one US cent. Credits don't buy anything yet. Guest identity, uploads and grants need sign-in, abuse limits, image decoding and moderation before public release.

## Current boundaries

Charts use actual observations and preserve collection gaps. Public data does not reveal private retention, revenue, demographic or thumbnail CTR metrics. Idea research finds candidate competitors; it does not certify originality or compare gameplay quality.

The credit ledger supports reservations, settlement and release. Private creation services save project context, briefs, concepts, review decisions and image jobs. UI assets follow an approved render; thumbnail references keep rights and reported performance separate. The OpenAI adapter is disabled by default, and the job runner rejects all paid providers. There is no checkout, public creation API or paid image generation enabled.

Creation code lives in `src/lib/creative`. It currently runs through trusted server calls and isolated tests. Its test tariffs are placeholder credit amounts, not prices. Jobs with ambiguous provider outcomes keep their reservation and require reconciliation; they are never retried automatically. Production needs authenticated owner identity, image decoding/moderation, private object storage, pricing and receipt reconciliation before these services can be exposed.

For test jobs, `reconcileCreativeJob` records an operator-confirmed outcome after the worker has stopped: release an uncharged hold, settle a charge without an image, or save recovered PNG bytes and settle the actual test-credit cost. It never calls a provider or approves the recovered concept. Conflicting replays fail, and charges still count toward the workflow budget when no output exists. This trusted internal operation is unavailable to agents and public MCP; production receipt verification remains unimplemented.

`src/lib/ui-library` provides private UI drafts, bounded search of explicitly shared entries, reuse into projects, and static Roblox UI export. Sharing needs a separate rights declaration and versioned consent to CC BY 4.0. Withdrawal removes related listings; listing deletion scrubs its content while private project assets and previously licensed copies remain separate. No marketplace is publicly enabled or seeded with third-party packs.

`src/lib/harness` adds private project runs, bounded model/tool steps, exact-action approvals, cancellation and durable results. Its project tools use the same analytics, skills, creation briefs and UI services. New agent model calls remain test-only. No authenticated agent endpoint or hosted Studio bridge is enabled. Interrupted mutations stay uncertain and require reconciliation before another run attempts the same work.

Trusted callers can supply test image/review providers to `projectTools` with a workflow credit cap and separate visual-review delegation. The agent queues durable image jobs; a separate worker calls `executeCreativeJob` to render them. A configured `ConceptReviewer` receives the actual stored concept image and records a bounded verdict before separate assets or a final thumbnail can be queued. Review claims, image hashes and outcomes stay private. No production vision adapter, background worker or paid review is enabled by this wiring.

An agent can return a `wait` decision for a job it queued. The run persists that wait without further model calls. Calling `runAgentToCheckpoint` after a worker event resumes from the actual terminal job status; uncertain jobs remain waiting for operator reconciliation. Cancelling a waiting agent stops its reasoning, while independently queued image jobs retain their own cancellation and settlement lifecycle.

The local Studio connector uses Roblox's [built-in MCP server](https://create.roblox.com/docs/studio/mcp). Enable it in Studio, then run `npm run studio:check -- <absolute StudioMCP executable path>` to list sessions. Add a returned session ID as the second argument for a read-only state check. On Windows the installed `Roblox/mcp.bat` names the executable; on macOS it is inside the Studio application bundle. The connector pins the chosen session, validates current tool schemas and requires harness approval for edits or Luau execution. Publishing, asset uploads, generation and playtesting tools are not exposed. Keep this local connector separate from Romanum's anonymous public `/mcp` endpoint.

## Checks

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run mcp:smoke
```

The MCP smoke test requires a running local application and contacts Roblox. Unit tests use isolated fixtures. Application schemas live in `db/migrations`; the local database launcher applies them in order.

## Repository

`src/app` contains routes, `src/lib` shared services, `skills` the portable guides and `tests` contract and storage checks. `skills` links [romanumdev/romanum-skills](https://github.com/romanumdev/romanum-skills) as a git submodule: clone with `--recurse-submodules`, or run `git submodule update --init` in an existing clone. Commit skill changes in that repository, then commit the updated link here. Internal planning and raw third-party transcripts are not distributed.

## Licence

Romanum's code and skills use the custom [Romanum Source-Available License](LICENSE). Commercializing the code, hosted copies, or skill packs requires separate permission. You may use the tools and skills to create and monetize your own games, images, UI assets and client work. Third-party rights still apply. See [third-party notices](THIRD_PARTY_NOTICES.md).
