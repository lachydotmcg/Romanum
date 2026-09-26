# Connected-game data plan

Status: proposed Stage 4 design, recorded 2026-09-26. No private connections, contribution toggle or deletion service exists yet. This is a product/engineering plan, not a privacy policy or a claim of legal compliance.

## Owner requirements

- Connect credentials to retrieve supported data from a developer's games and analyse it.
- Allow users to enable or disable contribution of that data to improve Romanum.
- Disclose collection and use, support deletion requests, and prepare a privacy policy before real release.

## Proposed controls

Use one on/off switch per connected experience: **Help improve Romanum**, off by default. Private analysis remains available with it off. Connecting a game authorises only the processing needed to provide its requested analytics, not optional reuse.

Suggested short disclosure, subject to the final approved purpose: “Share selected game metrics to improve Romanum's analysis.” A **Data use** link explains the exact fields, recipients, retention and derived uses before opt-in. Do not call data anonymous merely because names were removed.

Separately expose **Disconnect game** and **Delete game data**. Disconnect stops future syncing and removes Romanum's stored credential; it does not silently delete saved history or revoke the key at Roblox. Explain how to revoke the original key where supported.

Turning improvement sharing off stops new contributions and further improvement use of existing attributable contributions. Queue removal of those contributions and rebuilding of affected derived datasets. Keep the developer's private analytics unless they request its deletion. Re-enabling sharing should cover future observations only; importing earlier history requires an explicit choice.

## Connection and access design

1. Verify which official Roblox APIs actually expose the desired metrics, their scopes, terms and supported authentication. An API key must not be presented as unlocking all Creator Dashboard metrics. Evaluate OAuth if suitable; use scoped, read-only API keys where supported. Never request account passwords or session cookies.
2. Require authenticated Romanum accounts and verified authority for each experience, including group-owned games. Enforce project membership on every read, job and tool call.
3. Encrypt credentials server-side using managed secret/key storage, separate from analytics records. Never return saved keys to browsers, logs, model prompts or MCP responses. Support replacement, access loss and revocation.
4. Ingest only approved, necessary fields. Start with game-level aggregates; exclude player identifiers, chat, purchases and raw player events from the initial design.
5. Keep public observations and private observations in separate access paths. Private MCP requires its own authenticated, scoped access design; the current anonymous endpoint remains public-only.

## Data handling

Maintain distinct stores or strictly enforced boundaries for credentials, private observations, optional contributions and consent/deletion audit records. Every private record needs an owner/project, experience, source, observation time, purpose and retention class. Reports, embeddings, caches and exports need lineage to their inputs.

Record consent scope, notice version, actor and timestamps. Check current permission at job execution and before publishing derived results, not only when enqueueing. Withdrawal must invalidate queued work and prevent in-flight jobs from writing contributions under stale consent.

Begin optional improvement work with reversible, attributable datasets. Prefer aggregate analysis with minimum cohort sizes and checks for identifying individual games; thresholds and uses must be reviewed before publishing. Do not put private metrics into public skills or benchmarks by default.

Model training, third-party training, public benchmarking and selling data are not included in the proposed improvement switch. Each would need a separate product decision and specific disclosure/permission design. Do not begin irreversible training while promising contribution removal.

Private AI analysis may itself involve a model provider even when improvement sharing is off. Disclose that processing separately, minimise context sent, and verify provider retention/training settings before enabling it.

## Retention and deletion

Before private ingestion, choose and document retention periods for observations, reports, contributions, logs and backups; name who operates deletion and handles failures. Do not promise indefinite retention or instant erasure from backups.

Provide an authenticated deletion request with game/account scope, confirmation, progress and completion receipt. Initially this can use a documented operator workflow, but it must work before private-data testing with real users.

Deletion must stop syncing, invalidate jobs, remove credentials and relevant observations, reports, caches, embeddings and attributable contributions, and propagate to processors where applicable. Recompute affected aggregates where feasible. Track failures for retry. Explain any retained minimal audit records or genuinely non-attributable aggregates instead of claiming everything disappears.

Backups need bounded expiry and deletion markers reapplied after restoration so deleted data cannot return to service. Private deletion does not automatically remove independently collected public Roblox observations; explain that distinction in the data-use guide.

## Delivery order and acceptance

1. Verify API capabilities and field inventory; approve purposes, retention and processor choices.
2. Build authentication, project isolation and encrypted connection storage.
3. Add private ingestion and grounded analysis, with contribution disabled.
4. Implement and test consent withdrawal, job cancellation and end-to-end deletion before enabling contributions.
5. Review disclosures and privacy policy before real release.

Tests must prove cross-account access fails through UI/API/MCP, secrets stay out of logs/prompts, off-by-default users never enter improvement datasets, revocation stops jobs, withdrawal wins races, and deletion survives retry and backup restoration. No frontend placeholder should imply these controls work before they do.
