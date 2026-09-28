# Development and technical notes

[Documentation](README.md) · [Project introduction](../README.md)

## Analytics

Analytics includes Overview, Games, Trends, Genres, Charts and Earnings. The game directory filters Roblox's current chart sample by genre, chart, title or creator, with sortable public metrics. Charts can be built manually for free; the integrated AI can create comparisons and single-game historical lines from retrieved observations, preserving collection gaps. AI actions prepare a prompt for review before sending.

Free earnings estimates use CCU × hours × published genre assumptions. Game views project current CCU; the calculator takes average CCU, period and genre. Robux is the default, with standard pre-tax USD DevEx available. The model and coefficients are published at `/analytics/earnings-method`; these are uncalibrated heuristic ranges, not measured revenue or confidence intervals. The assistant and MCP share the same calculator through `estimate_game_earnings`, independently of PostgreSQL and paid model calls.

## Local development

Use Node.js 22.18 or newer (24 recommended).

```sh
git submodule update --init
npm install
npm run dev
```

Open http://localhost:3000. To collect public observations locally, run `npm run history:db` and `npm run history:watch` in separate terminals. Data stays under the ignored `.local/` directory. Collection lasts only while those processes run. Viewing a game does not enrol it in collection.

The integrated assistant and automatic insight recommendations use `DEEPSEEK_API_KEY` in `.env.local`. `OPENAI_API_KEY` enables the insights panel's additional web research; recommendations can run without it. Public analytics and MCP do not require a paid model. Keep provider keys on the server.

## PostgreSQL and scheduled collection

The web application reads `DATABASE_URL` when configured. Without it, development can use the database launched by `npm run history:db`. Production has no local database fallback. Heroku/RDS connections use the bundled public AWS trust anchors with certificate verification enabled.

The migration and collection scripts deliberately default to the local database, even if `DATABASE_URL` exists. To target a configured database, supply it in the shell environment and use `npm run history:migrate -- --configured` or `npm run history:collect -- --configured`. These standalone scripts do not automatically load `.env.local`.

On Netlify, `netlify/functions/history-schedule.ts` dispatches a background collection every five minutes. Set these variables alongside `DATABASE_URL`:

| Variable | Purpose |
| --- | --- |
| `HISTORY_COLLECTOR_ORIGIN` | The deployed HTTPS origin, without a path; it must serve the worker without a redirect. |
| `HISTORY_COLLECTOR_TOKEN` | A separate, cryptographically random shared secret of at least 32 characters for the timer and worker. |

The worker collects public observations for up to 300 games selected from four Roblox charts. It prevents duplicate collection slots and retries an upstream read once. Failed or missing observations remain gaps; collection is not exhaustive coverage of Roblox and cannot backfill time before recording began. The Netlify public collector does not sync private linked-game analytics.

Use the same stable `ROMANUM_SECRETS_KEY` across application instances that share encrypted game keys. Generate it from 32 cryptographically random bytes encoded as base64, and keep it in the host's secret environment settings. It is distinct from the collector token. Never commit `.env.local`, `.local/`, database credentials or private keys. Configure backups and retention for the hosted database.

## Turnstile

Guests verify with Cloudflare Turnstile when sending their first AI message, in Ask Romanum or Chats. Browsing and viewing the welcome balance do not trigger it. Roblox sign-in also requires verification. Set these server environment variables (the site key is sent to the browser at runtime):

```dotenv
TURNSTILE_SITE_KEY=your-site-key
TURNSTILE_SECRET_KEY=your-secret-key
TURNSTILE_ALLOWED_HOSTNAMES=your-domain.example
```

Create a **Managed** widget with the same hostnames in Cloudflare. Separate multiple hostnames with commas, without schemes or ports. The server checks Siteverify, the hostname and the action before a guest AI submission or starting OAuth. Missing configuration and verification outages block those operations. Browsing creates a signed pending identity with welcome credits; this cannot authorize an AI call. Verification upgrades the same identity, preserving its balance and history. Signed guest cookies and signed OAuth attempts prevent bypassing the check with invented cookies; adopted guests cannot reopen account data.

For `npm run dev` on localhost, use Cloudflare's [official test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/): site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`. They are rejected on non-local hosts and in production, including `npm run start`. Configure real keys, allowed hostnames and `ROMANUM_SECRETS_KEY` on Netlify before deployment. Test keys prove integration, not bot detection. Turnstile reduces automated sign-ups; it does not replace grant rate limits or spending controls. Public analytics and MCP remain accessible without a challenge.

## Chats and credits

Chats (`/chats`) are saved conversations with the same assistant. A message can carry up to three still PNG, JPEG or WebP reference images, up to 5 MB and 16 megapixels each (maximum 8192 pixels per side). Uploads are fully decoded, oriented, resized to fit 1600 × 1600 and converted to WebP with metadata stripped before private storage. Animated and malformed images are rejected.

Current-message images are sent as inline image inputs to `deepseek-flash` for thumbnail, UI and screenshot review. No public image URL or provider file store is used. Image tokens are included in the same metered call as text. Only text and attachment names enter saved model history; later visual inspections need reattachment. Deleting a chat removes its stored attachments. Image generation is still disabled, so generation requests produce written concepts. See [DeepSeek's vision guide](https://api-docs.deepseek.com/guides/vision) for provider limits and behavior.

Chats and attachments use the configured PostgreSQL database. For a separate development database, use `npm run history:db` and run `npm run history:migrate` after pulling new migrations.

A browser that isn't signed in is an anonymous guest identified by a signed cookie. A new guest receives 50 welcome credits, shown beside Guest in the sidebar. One credit is worth one US cent. Signing in keeps a guest's credits and chats, but anyone can still start a new guest, so grants and uploads need abuse limits and moderation before public release.

Ask Romanum and Chats answers spend credits: the tokens each model call reports, priced from `src/lib/credits/pricing.ts` (copied from the providers' official pricing pages, with the date checked), times a 1.65× markup. Each answer shows its cost. Credits are whole numbers, so each account's fractions carry over until they make a whole credit, which the ledger takes. Public data, charts, game pages and MCP stay free.

Each model step, including the optional follow-up suggestion, reserves its maximum quoted cost before contacting the provider. Quotes use conservative input bounds, the output limit and peak uncached rates; settlement charges reported usage and releases the unused credits. Concurrent requests cannot spend the same balance. SDK retries are disabled. Apply migration `014_usage_holds.sql` before deploying this behavior.

`usage_holds` records reservations without prompts or image bytes; `usage_charges` records settled usage. Explicit provider rejections release their hold. Disconnections, timeouts, missing usage and server failures retain it for reconciliation, because a provider may still have processed the request. Failed settlements stop further model steps. Operators should inspect open holds and reconcile against provider usage; never release or charge an ambiguous call solely because a timer elapsed. This does not change model pricing or enable payments.

## Project briefs

Chats is the shared entry point for conversations and projects. New chats show starters below the prompt bar, led by `Give me ideas`; `/projects/new` redirects to `/chats`. The assistant helps the user choose an idea, refine its hooks and game design, agree a roadmap, then work through implementation with the capabilities available. Users with an idea or existing game join at that stage. A signed-in chat can use `save_project_context` to create its project around the existing conversation, then update the name, core loop, audience, visual style, constraints, written game plan, roadmap and to-dos as decisions are agreed. Unknowns stay empty, and proposals are not represented as implemented work. The same chat, history and attachments remain in place.

A top-right context preview contains sections from the saved game design, core loop, audience, roadmap and to-dos. New saved AI decisions assemble into the preview; existing projects load without replaying the animation, and reduced-motion preferences disable it. At desktop widths the preview expands into a sidebar while chat remains usable; narrower screens use a modal drawer. Context includes direct brief editing, roadmap/checklist, private references and saved asset plans. Pristine editor fields follow incoming saved revisions, while unsaved edits retain their original revision for conflict checks and survive switching tabs or resizing. Project entries on the Chats home reopen the latest associated conversation; legacy `/projects` URLs redirect into this flow. Existing projects are preserved. The Context panel also lists related conversations, and a new conversation can share the same project context. Briefs reuse `creative_projects` JSON storage; no migration beyond `015_project_briefs.sql` is needed for the planning fields. Each owner can keep 100 projects, including archived ones. Updates require the last-read revision and return a conflict when another edit has won.

Starting a chat from a project saves that association. Each question reads the latest owner-scoped brief and includes it as user-level context, without adding another copy to saved chat history. The client cannot reassign an existing chat or select someone else's brief. A composite database foreign key enforces matching project/chat ownership. Archiving preserves the brief and existing chats but prevents starting new chats until restored. Project context grants no access to private linked-game analytics and is not shared through public MCP.

Only signed-in saved chats receive the context-writing tool. The server resolves the account, chat and current question; model arguments cannot choose a different project or owner. Saves require that question to remain the chat's latest user message. Context writes and account closure take the same owner lock before chat/project locks. One message can save context once and save up to three asset plans. Optional planning fields omitted during an update are preserved; explicit empty values can clear them. Public MCP, Ask Romanum and guest chats cannot write project context. Saving context does not enable image generation or hosted development agents.

Project chats can save written thumbnail and UI plans with `save_asset_plan`, then retrieve them with `list_asset_plans` and `read_asset_plan`. These tools are available only through the chat's server-resolved project scope, not ordinary chats, Ask Romanum or public MCP. A plan stores one to three concepts, its creative brief and a snapshot of the project revision used to write it. UI concepts include an asset breakdown. The project page lists saved plans, and each has an owner-only review page and Markdown download. Revisions create a separate plan.

Apply migration `016_project_plans.sql` before deploying plans. Written plans reuse `creative_workflows` with a zero image budget, no review delegation and no jobs. Normal chat token charges still apply; saving text adds no generation charge or approval. A question may attempt up to three saves and a project may keep 50 plans. Retries are keyed by the saved question and provider call ID. New saves reject archived projects or a changed brief. Deleting the source chat preserves its separately saved plans while clearing the link back to that chat. Generated output and reported thumbnail performance are not inferred from a written plan.

### Private image references

Each project has a private reference gallery. Uploads require a name and an ownership or permission declaration; these claims do not grant Romanum or other users a reuse licence. The server checks decoded PNG, JPEG or WebP bytes, rejects animation, strips metadata, corrects orientation and stores a PNG no larger than 1600 pixels per side. Limits are 5 MiB per upload, 24 references per project, and a 25 MiB owner quota counted across private creative assets. This bounded PostgreSQL storage is an initial implementation; larger libraries need private object storage and revised retention limits.

Project chats expose a reference picker. Only selecting an image and sending the message copies it into that chat's ordinary attachment flow, where it is normalized to WebP and sent as actual image input to the configured vision model. Uploading to the gallery alone does not call a model. Removing a gallery image leaves existing chat copies intact; deleting the chat or account removes those copies. Images referenced by saved creative workflows or UI-library records cannot be removed independently. Archived projects allow reading and removing references, but reject new uploads.

The `/api/projects/:id/references` routes resolve ownership from the signed-in session, require same-origin mutations, and return private, uncached image responses. No reference gallery is public, no marketplace consent is inferred, and no image-generation jobs or credits are created by uploads. Paid generation remains disabled. The existing creative-asset schema is reused without an additional migration.

## Sign-in and linked games

Sign in with Roblox uses OAuth 2.0 with PKCE and asks only for `openid profile`. Register an app under Creator Dashboard → OAuth 2.0 Apps with the redirect URL `http://localhost:3000/auth/roblox/callback`, then set `ROBLOX_CLIENT_ID` and `ROBLOX_CLIENT_SECRET` in `.env.local` (`ROBLOX_REDIRECT_URI` overrides the callback). Until Roblox reviews the app, it allows 10 users. A new account adopts the browser's guest credits and chats and receives 150 extra credits once per Roblox user, in addition to the 50 welcome credits. Existing accounts receive any missing bonus on their next sign-in or balance refresh; spending is preserved. Romanum keeps no Roblox tokens, and stores only a hash of each session's cookie.

Signed-in developers link a game on Your games with its universe ID and an Open Cloud API key that has `universe.analytics:read` for it. Romanum checks the key with Roblox, encrypts it with AES-256-GCM (`ROMANUM_SECRETS_KEY`, 32 bytes in base64, generated under `.local/` in development) and syncs eight daily game-level metrics from the Analytics Query API, which is in beta. Syncs run on linking, on profile visits and in `npm run history:watch`, at most every six hours. Each game has **Collect analytics** (on) and **Help improve Romanum** (off by default, covering only days after it's turned on). Both are enforced where metrics are written and read, and every change is recorded. Disconnect deletes the key; Delete data removes the game and its metrics. Private metrics appear only to their owner, on Your games and the game's page, never in public tools, MCP or the assistant.

The privacy policy lives at `/privacy`; signed-in users can export or delete their account from Settings → Your data. Shared metrics are not yet used for platform analysis, and linking games still requires a pasted key. The Analytics Query API is in beta; check synced metric units against Creator Dashboard when validating a connection.

## Account data downloads

Settings → Your data (`/profile/data`) downloads a ZIP of the signed-in account's profile, credit history, chats, projects, written plans, creation records, UI-library records and linked-game analytics/consent choices. Images are optional. Private keys, session hashes, internal claim identifiers and operator reconciliation evidence are excluded; the owner's own UI-rights declarations are included. JSON sections use explicit column allowlists. New tables or fields need a deliberate export decision and coverage tests.

`GET /api/account/export` resolves the session on every request. Pages and image chunks are owner-scoped and uncached. An expected-account header prevents the browser from combining accounts if another tab signs out and signs in. Each page uses a repeatable read, but the whole archive is a series of live reads; it is not a frozen database snapshot. Concurrent edits can affect the result. The archive README and timestamps describe this limit.

The browser assembles the ZIP with fflate and downloads it only after every requested page and image is complete. No export is stored on the server. PostgreSQL measures projected record sizes before transferring contents; pages contain up to 100 records/512 KiB, with a single-record allowance of 3 MiB. Images use 512 KiB slices. Browser archives are capped at 128 MiB and 50,000 files. Oversized or interrupted exports fail explicitly instead of silently truncating. Larger exports will need a private background export job and expiry policy before this limit is raised. Stored chat images are normalized copies, not original uploads. Downloads do not delete data or change consent.

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

Privacy controls, account closure and release-review items are documented in [privacy operations](privacy-operations.md).

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run mcp:smoke
```

The MCP smoke test requires a running local application and contacts Roblox. Unit tests use isolated fixtures. Application schemas live in `db/migrations`; the local database launcher applies them in order.

## Repository

`src/app` contains routes, `src/lib` shared services, `docs` technical documentation, `skills` the portable guides and `tests` contract and storage checks. `skills` links [romanumdev/romanum-skills](https://github.com/romanumdev/romanum-skills) as a git submodule: clone with `--recurse-submodules`, or run `git submodule update --init` in an existing clone. Commit skill changes in that repository, then commit the updated link here. Internal planning and raw third-party transcripts are not distributed.

Keep auto-discovered build configuration and package manifests at the project root so local commands, editors and Netlify agree on the application directory. The README and canonical licence also stay at the root; supporting documentation and third-party notices live in `docs/`. Local `AGENTS.md` instructions are ignored by Git, and Next.js agent-rule generation is disabled.
