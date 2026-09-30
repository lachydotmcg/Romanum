# Private imported ad reports

Project Context → Ads accepts owner-uploaded evidence independently of linked-game API keys. Apply `022_ad_reports.sql` with the existing migration runner before using the feature. Uploads, deterministic calculations and these private tools have no tool surcharge. Hosted AI interpretation still uses the existing metered Chats model. Public analytics and public MCP remain free and do not expose imported evidence.

## Validated sources

The native parser supports the supplied Roblox aggregate schema, as CSV or a ZIP containing CSVs. Filenames must follow `Roblox_{Campaigns|Ads}_{cohort}_Aggregated_YYYY-MM-DD_YYYY-MM-DD.csv`. Supported cohorts are `AllUsers`, `NewUsers`, `ReturningUsers`, `7DResurrected` and `30DResurrected`. Exact headers are validated, including the `USD Revenue` column present only in AllUsers. Unknown schemas are rejected rather than interpreted by a model.

The owner-provided source was materialized from Library and its local bytes verified. It contains ten aggregate CSVs, including four header-only resurrected-cohort files and a campaign with blank summary counts despite populated ad rows. Local regressions preserve that discrepancy; no reconciliation is invented. The private ZIP and its golden identifiers/results are external fixtures, not distributed in Git.

No native Roblox daily export was provided or verified. Daily support is therefore an explicit Romanum CSV v1 template downloadable in Ads, with filename `Romanum_Daily_v1_{Campaigns|Ads}_{cohort}.csv` and this exact header:

```csv
date,campaignId,campaignName,adId,adName,universeId,objective,adFormat,impressions,clicks,plays,spend,paymentType,reportedCtr,reportedPlayRate,reportedCpc,reportedCpp
```

One row represents one campaign or ad on one ISO calendar date within a declared reporting window. Ads require `adId`; campaign rows leave `adId` and `adName` blank. Counts are nonnegative integers, spend is nonnegative numeric, and canonical reported rates are fractions (`0.02` means 2%). Empty numeric cells, hyphens and em dashes mean unavailable; `0` is a measured zero. Native aggregate CTR/play-rate percentages are converted separately. Complete CSV quoting is supported. Header-only cohorts remain absent observations, not zero-valued rows.

Each import records the declared timezone, attribution window, placement, audience and currency/spend unit, or explicit unknowns. Aggregate filename dates define its reporting window; campaign lifetime dates and the export timestamp do not replace it. `Ad Credit` payment method does not imply USD. Context is immutable per import; a contextual reinterpretation is a separate visible record. Exact repeated source files under the same context deduplicate even if archive metadata changes. Repeated identical observations within an upload are skipped; conflicting duplicates are rejected. Source filenames, SHA-256 hashes, source line numbers, raw cells and reported metrics are retained alongside calculations.

## Interpretation and learning

Paid CTR is clicks / impressions. Plays / impressions is a separately named ratio, not discovery PTR. CPC and cost per play use spend and their respective denominators. Missing counts stay missing during sums; a zero or missing denominator produces no ratio. Plays may exceed clicks and are kept with an attribution warning. Mixed/unknown payment methods cannot silently produce a combined spend or cost metric.

Selections explicitly separate cohort, campaign/ad entity and aggregate/daily grain. Cohorts overlap and are never added together. Campaign summaries are not added to ad rows. Daily comparisons use effective selected dates within each export's bounds, so equal selections can compare across different enclosing export windows; aggregate comparisons require equal whole-report windows. Comparisons require compatible known periods, timezone, attribution, audience, placement, universe, objective and ad format. Every returned cost delta requires known matching spend units and a single matching payment method, including when comparing CTR. Missing daily dates, mixed delivery context and unavailable metrics block a definitive comparison. Small samples receive warnings and no winner. Any ranking is descriptive, not statistical significance or evidence of creative causation.

Owners explicitly associate an Ad ID with an existing private project reference image. The platform does not infer associations from names or overwrite CSV zeros using screenshot dashes. Changing an association replaces the current mapping. Image metadata is not pixel analysis: choose the reference in a chat message to authorize sending its pixels.

Private observations, hypotheses and owner-marked tested results cite one or more reports and optionally creatives. Revisions append a superseding record rather than silently changing an earlier note. A tested label is an owner's assertion, not automated scientific validation. Deleting a report deletes dependent observations, supersessions and its creative mappings. Account export includes reports, associations, learning records and consent history; account closure removes all imported-ads data.

## AI and thumbnail handoff

Imported evidence has a separate, default-off, versioned AI-analysis permission per project. Uploading alone does not authorize sending reports to a provider. An authenticated project chat exposes `list_ad_reports`, `read_ad_report`, `compare_ad_reports`, `read_ad_learning_history` and `prepare_ad_thumbnail_brief` under server-resolved ownership. These do not appear in anonymous/public MCP. Consent and source existence are checked again after retrieval and immediately before each provider request, including after a model-credit reservation. Old private tool payloads are withheld from later turns. Written answers/plans remain in history; turning consent off does not recall earlier provider requests.

With consent, the existing durable Chats worker can continue a review and retain progress. The planning link prepares a prompt for the owner to review and send. `prepare_ad_thumbnail_brief` provides metrics, citations and explicitly mapped creative IDs; the assistant can load existing thumbnail guidance and save a written `save_asset_plan`. No image job is queued, no external ad is changed, and production image generation stays disabled. Shared skills are unchanged. Platform-improvement sharing is unavailable; private observations are not merged into shared memory or model training.

## Limits and validation

Uploads are limited to 10 MiB; expanded archives to 20 MiB, 20 CSV files and 20,000 observations. Extraction reads only validated entry slices; ZIP64 locators/extra fields, unsafe names, unsupported entries, malformed CSV, overlapping entries, metadata inconsistencies, excessive compression and CRC mismatches are rejected. DEFLATE output is capped during native decompression at the validated declared size and checked for exact size, checksum and consumed compressed bytes. A forged short size cannot silently truncate a larger expansion. Received request bytes are bounded independently of Content-Length. Normalized storage is limited to 50 reports/5 MiB per project, 25 MiB per owner, 200 learning records and 500 creative mappings.

Run the source-fixture test by setting `ROMANUM_ADS_FIXTURE` to the actual local ZIP and `ROMANUM_ADS_EXPECTATIONS` to its private local golden verification JSON, then run:

```sh
node --test tests/ad-reports-import.test.mjs
node --test tests/ad-reports-store.test.mjs tests/ad-reports-http.test.mjs tests/ad-reports-assistant.test.mjs
```

Other fixtures are synthetic and use isolated PGlite databases. Provider/billing tests use mocks and make no paid calls. An unset real-fixture environment variable explicitly skips the private-fixture test. Full integration checks are the repository test suite, ESLint, TypeScript and production build. A real provider review and deployed migration remain operator integration steps.
