# Model catalog and policy foundation

This module describes models, local readiness, one-call token quotes, routing proposals and provider-reported usage. It does not execute a provider request, create a wallet hold, settle a ledger or replace the released pricing module. New provider/model execution remains disabled in `RELEASED_EXECUTION_REVIEWS`, even when a key is present. Only the released DeepSeek Flash adapter is marked reviewed.

## Public contracts and transport

Client code imports contracts from `types.ts`. `GET /api/models` returns `ModelsResponse`, with catalog metadata and configuration booleans, and sends `Cache-Control: no-store`. `readiness.ts` reads key presence per invocation on the server. `configured` means a nonempty key exists; `adapterSupported` and `executionEnabled` mean local reviews permit execution; `selectable` requires all three. `entitlementVerified` remains false: this endpoint performs no authentication or provider-entitlement probe and exposes no key, environment object or provider error.

The integration field is `modelSelection`: `{ mode: "auto" }` or `{ mode: "explicit", modelId }`. Ask transports it in JSON; Chats transports JSON-encoded `modelSelection` in FormData. Both routes validate current server readiness and trusted request bounds; durable chat runs persist the requested selection and resolved `RouteDecision`, and revalidate the pinned adapter before every submission. `parseModelSelection` accepts only the exact allowlisted IDs and rejects injected configuration or extra properties. Auto remains Auto in the UI; an explicit choice is never silently replaced. A blocked decision may offer a separate affordable alternative, which requires a new user choice before execution. Execution integration still supports only DeepSeek Flash; a new provider key or readiness flag alone cannot enable another model.

## Readiness, quoting and routing

`routeModel(request, readiness)` is pure. Auto filters locally ready models by requested text/tool/image capabilities and conservative request limits, then selects the lowest estimated price among models whose full reservation is affordable. Ties use reservation price and exact model ID. The current policy caps every request at 200,000 combined input/output tokens and 16,000 output tokens; these are Romanum limits, not vendor-advertised maximums. The broad tool flag does not remove adapter constraints, such as Luna's Chat Completions reasoning setting.

Supply trusted token estimates and conservative maximums in `TokenBudget`, including message framing, tools, vision and reasoning. The quote covers one text-token request only. Tool fees, image-generation fees, repeated tool-loop requests and other provider charges require separate reviewed bounds before execution. Estimates may use compatible historical cache hits; reservations always cover the higher all-miss or all-write case, maximum output and DeepSeek peak rates. Cache hits are never guaranteed. Unsupported TTLs, malformed bounds, unsupported capabilities and unavailable choices fail closed.

`reservationCredits` mirrors the existing wallet policy: `ceil(priceNanoUsd / 10_000_000) + 1`. Every positive hold needs at least two whole credits, including a quote below one credit. The existing 1.65 markup and wallet behavior are unchanged. A routing result is a proposal: trusted integration must recheck current server readiness, ownership, consent and balance, and atomically obtain the existing wallet hold immediately before each submission. Never trust client-provided readiness, balance, usage or hashes. Do not automatically retry an ambiguous or billed failure on a different provider.

## Cache scenarios and actual usage

`CacheBinding` binds owner, conversation, provider, exact model, prefix hash, tool-schema hash and settings hash. Hashes must be lowercase SHA-256 digests. The integration must hash the actual stable prefix and all cache-relevant settings, including TTL/reasoning/output mode. `cacheKey` is a metadata digest, not an authorization boundary. This module stores no raw prompts, private tool data or result bodies and never reuses generated answers. An observation supplies a conditional cost scenario only when all bindings match and its timestamp is past and unexpired; a newer miss supersedes an older hit. Providers can still evict or reject a compatible prefix.

`normalizeUsage(modelId, rawUsage, options)` accepts trusted final/cumulative usage. Adapters must merge streaming counters before calling it and validate the returned model and pricing modifiers, including metadata outside the usage object. Reasoning tokens already included in output totals must not be added again. Input categories are mutually exclusive:

| Provider | Ordinary input | Cache read | Cache write |
| --- | --- | --- | --- |
| DeepSeek | Reported miss, or total prompt minus hit | Reported hit | No separate write category |
| OpenAI | Total input minus read and write | Cached tokens | Reported cache-write tokens |
| Anthropic | `input_tokens`, already excluding reads/writes | `cache_read_input_tokens` | Separate 5-minute/1-hour creation counters |

Anthropic creation counters must sum to the reported creation total. If that breakdown is absent and writes are nonzero, the trusted request's 5-minute/1-hour TTL is required; it is never guessed. Conflicting totals, invalid counts, unsupported write categories, provider mismatches and rate-card mismatches throw. `costUsage` computes standard/global token cost only; reported nonstandard tiers or geography are rejected. These functions do not settle actual accounting. Preserve the rate-card version with usage/quotes, and retain the relevant historical card when future versions are added rather than repricing old records with current rates.

## Rate-card provenance and limits

The independent card is `2026-10-02.standard.v1`, checked at `2026-10-02T12:05:51.000Z`. Each catalog entry includes official model, pricing and caching links. Prices are USD per million tokens. OpenAI full-request long-context multipliers are retained for actual-usage calculations above 272,000 input tokens, although routing policy currently prevents that size. Anthropic 5-minute and 1-hour write prices remain separate. DeepSeek uses the released weekday UTC peak convention and conservatively treats Chinese holidays as weekdays; a reviewed holiday calendar is needed for exact holiday settlement before adopting this module for billing.

Official references: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic models](https://platform.claude.com/docs/en/models/overview), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [DeepSeek caching](https://api-docs.deepseek.com/guides/kv_cache/).

## One-time Auto recommendation

The selector recommends Auto once when a verified non-subscriber deliberately changes from Auto to an enabled model. The explicit choice applies immediately; Continue, dismiss and Escape retain it, and Use Auto requires a separate click. The notice describes balancing model capability, price and credit budget without promising the best model or guaranteed savings.

`GET /api/models/preferences` is a separate, private/no-store, read-only UI endpoint. For an existing account-session cookie it resolves the verified session and reads that account's current `accounts.credit_plan`, the same authoritative `free`/`subscribed` flag used by weekly-credit eligibility. It maps `free` to `none` and `subscribed` to `active`. Missing/failed session or database reads, deleted accounts and unfamiliar flags yield `unknown`, with no guest fallback. Without an account-session cookie it verifies an existing anonymous guest through the existing signed-cookie and unclaimed-owner checks; guests cannot hold account subscriptions. The UI shows advice only for `none`. This metadata never changes the model catalog, plan access, provider readiness, balance checks or holds.

The acknowledgement is a versioned browser preference under an opaque hash of the current owner scope, shared by Ask and Chats and retained when sign-up adopts the guest's owner. It is written before showing the notice and survives refresh. Dismissing without changing models, repeated clicks and a second composer do not repeat it. Opening the picker can refresh unknown identity when the sidebar established a guest after the initial read. Unknown state on the first deliberate switch is skipped, not deferred. If browser persistence is blocked, advice is suppressed. Clearing browser storage or changing owner identity resets this preference; it is not a cross-device preference.

## Offline verification

Run `node --experimental-strip-types --test tests/model-readiness.test.mjs tests/model-cache.test.mjs tests/model-usage.test.mjs tests/model-routing.test.mjs`. Fixtures cover missing/removed keys, disabled execution, secret-safe output, forged selections, capability and token limits, low balances, peak boundaries, cache-binding changes, expiry, missed caches and mutually exclusive usage categories. They require no credentials, provider SDK calls or production database. Lint, TypeScript and the production build verify the endpoint without enabling new execution.
