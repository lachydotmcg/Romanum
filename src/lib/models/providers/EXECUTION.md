# Disabled native provider execution

The shared Ask/Chats engine now executes the exact selected OpenAI Responses or Anthropic Messages model through `assistant/provider-execution.ts` and the existing application tool loop. All seven native provider entries in `RELEASED_EXECUTION_REVIEWS` remain `executionEnabled:false`. Keys, imports, selector choices, browser assertions and environment flags cannot enable them. DeepSeek Flash retains its released streaming and billing path; DeepSeek V4 Pro remains unsupported.

Each native step validates the pinned route and permissions, snapshots the server request, compiles exact native bytes, derives an owner/feature/conversation/run/step attempt ID, obtains an atomic wallet hold, revalidates cancellation/readiness/access, and commits a single dispatch claim before transport. The adapter rechecks the same request hash and dispatch time. Trusted normalized final evidence must match the exact model, provider, request, dispatch, adapter, pricing profile and rate card. A completed result reaches the engine only after normalized settlement commits. Tools still pass through the application's authoritative validation and authorization. Native text is delivered after verification; readable/opaque reasoning is never a UI event.

`credits/provider-attempts.ts` and `db/migrations/023_provider_attempts.sql` bind these steps durably. Final evidence/candidate and global response attribution commit before the separate atomic fractional-carry/capture/charge/receipt transaction. A failed capture preserves the candidate; `settleProviderAttempt` recovers accounting without transport or tool execution. Reservation, dispatch and unused release also run in transactions. Duplicate callbacks return zero new price/debit; conflicting finals preserve the charged state. One provider response can settle only one attempt globally. Actual price uses the existing `Math.round(cost * 1.65)`, one credit per $0.01 and fractional carry. Quotes use ceiling markup and reserve `ceil(price / credit value) + 1`; they are separate from final cost. All cache categories remain disjoint and reasoning remains within reported output. Normalized audit rows carry display-only legacy aliases for existing admin aggregation.

## Reviewed monetary bounds

`request-bounds.ts` supplies `native-context-window / 2026-10-03.v1`, bound to exact model, adapter/request versions, capabilities, cache TTL and request hash. The monetary rectangle covers the **entire native input context window plus the explicit output cap**. Those two maxima need not occur together. Actual input plus output must still fit the native window. The existing 200,000-token application admission policy and 16,000 output cap remain unchanged; bytes/framing are admission and estimate inputs, never a proof of the monetary ceiling. Inline images are limited to three and 2 MiB decoded total. Hosted/server tools, compaction, provider-managed loops, Pro/beta modes, regional/priority pricing and automatic retries are excluded.

| Exact model | Native input ceiling | Maximum hold at 16k output, credits |
| --- | ---: | ---: |
| GPT-6 Luna | 1,050,000 | 47 |
| GPT-6.1 Sol | 1,050,000 | 907 |
| GPT-6 Astra | 1,050,000 | 4,531 |
| Claude Haiku 4.5 | 200,000 | 56 |
| Claude Sonnet 5.5 | 1,000,000 | 440 |
| Claude Opus 5.5 | 1,000,000 | 879 |
| Claude Fable 5.1 | 1,000,000 | 2,196 |

Holds cover worst-case permitted cache writes. OpenAI's input above 272k costs 2x input/cache and 1.5x output for the entire request, so its full-window quote includes those premiums. Current Anthropic 1M models have standard context pricing. Actual settlement uses the verified counters and applicable rates, releasing unused reservation. Conservative holds can require substantially more available balance than the eventual charge; reducing them requires another documented, reviewed bound, not a guessed token margin.

Official sources verified before this milestone: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [OpenAI context](https://developers.openai.com/api/docs/guides/conversation-state), [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [OpenAI cache writes](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic context](https://platform.claude.com/docs/en/build-with-claude/context-windows), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Anthropic [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) is an estimate; no counting endpoint was called.

## Continuation and failure behavior

Authentic encrypted OpenAI items/phases and omitted Anthropic thinking signatures stay in the current invocation's private Map and replay verbatim for tool rounds. Tools and top-level instructions remain stable. A final analysis deadline adds a user instruction while keeping schemas fixed and suppresses further tool effects. Earlier completed Chat Completions tool history becomes visible historical text/results; it cannot supply native reasoning. Browser-provided continuation fields are discarded by HTTP parsing and are never accepted as native provenance.

There is no automatic crash replay or resume of native output/tool effects. Ask binds an invocation UUID; synchronous guest Chats bind saved chat/question IDs; background Chats bind saved chat/run IDs. Every subsequent step has its own durable ID. A claimed attempt loaded by another worker fails closed. A crash or lost commit acknowledgement after claim keeps the hold even when transport might never have started; this is a reservation, not a debit. Missing/partial usage, model mismatch, cancellation/timeout or unsupported pricing retains evidence/hold for authorized reconciliation. Definitely undispatched cancellation releases. Truncation may settle attributable input/reasoning usage but drops tools and reports the answer as incomplete. No fallback or retry occurs.

The shipped catalog contains one immutable rate card. Historical attempts fail closed if its version or reviewed strategy changes. Add an explicit historical registry before retiring this version; never reprice old evidence from a newer card. Native continuation is not durably stored, so interrupted tool loops require a new user turn and accounting reconciliation rather than automatic continuation.

## Minimal activation sequence — not performed

1. Integrate this backend candidate with verified selector commits `a2470aa`, `76b9caa`, `3a0b3f7`; resolve any later backend/schema conflicts. No UI implementation changes belong to this candidate.
2. Apply migration `023_provider_attempts.sql` through the normal migration runner only to a separately authorized target after parent/release coordination. No live schema or data has been changed here.
3. Run independent PostgreSQL connection/process concurrency checks: competing reservations and dispatches, duplicate/cross-owner finals, wallet carry, rollback and uncertain commit acknowledgement. PGlite fixture transactions are serialized and do not prove those production interleavings.
4. Obtain separate authorization for a bounded provider entitlement/protocol smoke using already-approved server credentials. Verify exact model reporting, cache-write details, native continuation, reasoning/output totals, tier/geography and final usage fields. No credential change, entitlement check or paid call was performed here.
5. Review the conservative hold sizes and the operational reconciliation path, then change only the intended hardcoded execution review entry to `executionEnabled:true` in a separately approved release. No additional engine or ledger hookup is required. Provider factories and public readiness remain disabled until that change; do not introduce environment activation flags or retries.

Fixture validation covers all seven models from routing through native parsers and wallet settlement; authentic tool loops; long-context/cache-write ceilings; exhausted credits; cancellation before/after dispatch; response mismatch; stalled deadlines; lost commit acknowledgement; duplicate workers/callbacks; conflict/over-bound retention; normalized audit compatibility; and existing DeepSeek flows. Schema application in those tests is confined to ephemeral in-memory PGlite databases.
