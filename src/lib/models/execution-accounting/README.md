# Pure execution/accounting contract

This module proposes immutable state transitions between a prepared model request, its reservation, a dispatch claim and accounting evidence. The module itself performs no transport, authorization, reservation, charge, release, database write or tool execution. Its separate [disabled engine integration](../providers/EXECUTION.md) now consumes these proposals through `credits/provider-attempts.ts`, durable holds/dispatches and atomic normalized ledger settlement. Native provider execution remains disabled pending release/activation checks.

## API and trust boundary

`createAccountingContract(policy?)` in `decision.ts` snapshots a trusted server-owned policy and returns:

| Method | Result |
| --- | --- |
| `prepare(input)` | Validated, frozen `PreparedAttempt` with generated review and binding fingerprints. |
| `validatePrepared(stored)` | Revalidated prepared snapshot, including recomputed fingerprints and quote. |
| `hold(prepared, actualHoldBinding)` | Initial `held` state at revision zero. |
| `submit(state, { expectedRevision, dispatchId, requestHash, submittedAt })` | Proposed `submitted` state; persist the winning claim before transport. |
| `decide(state, outcome, { expectedRevision })` | Proposed `retained`, `candidate` or `released` state. |
| `validateState(stored)` | Rebuild and verify a stored state by replaying its bounded evidence history. |

Errors are `ContractError` with a fixed `code`; messages never interpolate provider responses or private data. Public DTOs and the function signatures are in `types.ts`. Helpers exported from `validate.ts` serve this module's implementation.

The terminal phase names `released` and `candidate` describe finalized **proposals**. `released` does not mean a ledger release happened, and `candidate` does not mean settlement happened. Their durable financial effects must be committed and acknowledged separately.

The pure contract's default bounds-review registry is **empty**. Merely supplying a nonempty bounds version, enabling a model selector, having a key, or passing a browser-provided `verified` flag grants no capability. Each injected review binds a strategy/version to one provider, model, adapter version and translated-request format, with reviewed capability/TTL coverage and input/output maxima. Reviews are snapshotted, fingerprinted and included in the attempt binding. The disabled native integration injects the separately reviewed full-context ceilings in `providers/request-bounds.ts`; standalone contract tests also use explicitly synthetic reviews.

The registry and all accounting DTOs must originate in trusted, owner-authorized server code. Shape validation and SHA-256 fingerprints do not establish that authority. In particular, this module cannot prove that a caller actually ran the reviewed bounding algorithm, measured the supplied request or read a real hold. Never expose these constructors directly as browser-controlled JSON actions or build the registry from request fields or environment flags.

## Binding the real request and hold

The integration must privately compile and snapshot the exact translated provider request, run the reviewed bound on that same immutable request, and derive its `requestHash`. Hash the exact serialized request bytes plus a versioned, unambiguous representation of all nonsecret transport settings that affect behavior or pricing: endpoint/geography, exact provider model, ordered system/history/tool schemas/tool results, images if reviewed, output/reasoning caps, cache settings, service tier, API/beta version and any continuation identity. Credentials are excluded. Opaque continuation contents stay in private owner-scoped history and are never copied into this accounting record.

The module accepts that independently derived hash and requires the bound proof to name the same hash. Immediately before dispatch, the adapter must derive the hash again from the bytes and settings it will actually send; `submit` checks equality. A reused asserted hash cannot detect mutated request bytes by itself. Prevent later mutation, disable SDK retries and automatic fallback, and transport exactly the snapshotted request.

Generated binding/candidate fingerprints use versioned SHA-256 domains and fixed-order serialization of bounded, validated known-field snapshots. They contain no raw request data and are integrity/conflict identifiers, not signatures. The prepared binding covers owner, feature, conversation, run/step, stable attempt ID, pinned selection/model/provider, request hash, review, budget, quote, profile and preparation time. Auto remains a recorded selection with one pinned execution model. Each paid tool-loop step needs a new full-history bound, request hash, quote and attempt/hold.

`actualHoldBinding` requires `holdId`, `ownerId`, `feature`, `maxPriceNanoUsd`, `reservedCredits` and `bindingFingerprint`. The persistence bridge reads those values from actual owner-scoped hold/attempt rows created or loaded atomically. Owner, feature, fingerprint, nano-USD ceiling and whole-credit reservation must match exactly. Two different positive nano ceilings can reserve the same two credits, so matching credits alone is insufficient.

`runId` may be null for synchronous Ask. The integration derives durable IDs from an invocation UUID or saved chat/question/run identity, owner, feature and step. A prior dispatch cannot be retried; background runs additionally bind their saved run ID. The pure contract cannot determine ownership or invent durable keys.

## Evidence and decisions

All timestamps are canonical millisecond UTC strings. `NormalizedUsage.at` must equal the saved submission timestamp; provider end time must not silently replace it. The pricing-time attribution policy still needs separate review, especially DeepSeek peak/off-peak and holidays.

The complete foundation `ModelQuote` and `NormalizedUsage` are reused. Five mutually exclusive input categories (miss, read, generic write, 5m write, 1h write) and total input/output remain separate. Output already includes reasoning. Counters must be safe nonnegative integers; category totals must agree. Quotes are recomputed from the catalog and trusted bounds, with no caller-selected price. Cache-aware estimates may differ from uncached estimates, but cannot lower the independently recomputed reservation ceiling or imply a guaranteed hit. Existing markup, credit value and the positive two-credit minimum remain unchanged.

| Evidence/state | Decision |
| --- | --- |
| Initial held state, failed/cancelled, no usage, positively reported not submitted | `release_unused` proposal. |
| Any persisted dispatch claim, even a later adapter report that fetch never happened | Retain; there is no automatic post-claim release. |
| Missing dispatch identity, uncertain submission, absent or partial usage | Retain. |
| Invalid response, unverified pricing, unsupported charges, response/model mismatch, unavailable card, contradictory counters/history | Retain safe evidence for reconciliation. |
| Attributable completed-adapter final evidence inside all request, TTL, quote and reservation bounds | Immutable `settle_candidate`; never a settled receipt. |

A final envelope needs provider-message identity, exact reported model, provider, adapter version, dispatch ID, request hash, rate card, pricing profile and a completed terminal protocol source in addition to usage. No model aliases are accepted. These are trusted adapter assertions that are checked against the stored binding, not externally verified credentials. A `usageComplete` boolean is neither accepted nor sufficient. The current adapter's failed branch cannot become a candidate even if that boolean is true; semantic failures need a separately reviewed future evidence contract. The completed branch can report refusal or truncation with attributable final usage; a candidate grants no tool-execution permission.

Malformed DTOs throw without changing the prior state. Persist a safe `invalid` evidence envelope with a reason and optional report digest when the adapter cannot produce valid typed counters/identities; never persist raw provider errors here. Structurally valid but inconsistent totals or identities are retained. Retained outcomes remain in the immutable evidence history. Cumulative partial snapshots replace counts conceptually; the reducer never adds them. Regressions or conflicting final evidence prevent a later candidate. A later valid final envelope can reconcile merely absent/partial evidence. Contradictory evidence requires a separate authorized reconciliation process.

The `uncertain` field is a monotonic historical latch: it becomes true at dispatch claim or retention and stays true even on a later candidate. It is not the current ledger status. A candidate resolves eligibility without erasing the fact that dispatch was claimed. Prior uncertainty can never be downgraded into `release_unused`.

Candidate eligibility compares a conservative peak cost plus quote-style `ceil` markup to the **nano-USD quote ceiling**, then checks whole-credit coverage separately. A 1h write cannot hide beneath the same two-credit reservation as an insufficient 5m quote. A 1h bound may cover mixed 5m/1h writes; a 5m bound cannot cover 1h writes. This eligibility check does not replace existing settlement `Math.round` pricing or fractional carry. Candidates deliberately contain no authorized debit amount.

Evidence history is limited to 32 outcomes, identifiers and arrays are bounded, and unknown fields/accessors/exotic records are rejected. Exhaustion or a validation exception must leave the durable reservation and earlier evidence intact; route it to reconciliation. This is a compact accounting record, not a transport log.

## Durable integration contract

The disabled engine and `credits/provider-attempts.ts` implement these boundaries. The pure constructor remains independent of their database/authorization guarantees.

1. Recheck owner/conversation access, run ownership/cancellation, actual adapter readiness and supported pricing/capabilities before preparing and again before submission. An accounting constructor does not perform any of these checks.
2. Under an owner-scoped stable logical attempt key, atomically create/load the attempt and one actual hold. Enforce unique attempt/hold associations and reject a different binding on retries. The existing wallet availability check remains authoritative.
3. Persist the `submit` proposal with a compare-and-set against the prior revision and phase, together with a unique dispatch claim. **Only the winning transaction may call the provider.** Never keep a database transaction open over network I/O. A crash after the claim is ambiguous, including a crash before fetch starts. Do not dispatch a claimed attempt again.
4. Persist validated evidence and a decision with revision CAS independently of client disconnection, run cancellation, run expiry or UI completion. A run ending never implies a release, settlement or new dispatch. Reject mismatched owner/attempt/hold lookups before attaching evidence.
5. Commit final evidence, the candidate and global provider-message attribution before invoking ledger capture. The bridge resolves the pinned rate card, validates the original quote/hold again, recomputes actual cost and existing `Math.round`/carry policy, and atomically commits hold/ledger/charge transitions under their existing locks. It enforces candidate/attempt/hold uniqueness and provider-message replay protection, including complete TTL counters and policy/rate identity in the settlement fingerprint.
6. If capture fails or its response is lost, reload the saved candidate through `settleProviderAttempt` and retry/replay **accounting only**. An identical committed fingerprint returns the stored ledger receipt with zero new price/debit; a conflict fails. Do not invoke the provider again, top up an over-quote request or run the legacy charge path in parallel. `LedgerSettledReceipt` is a distinct bridge type; this pure module has no receipt constructor and cannot assert settlement succeeded.
7. Persist/display settled totals once per attempt/hold and receipt. Authorize later paid steps and validated tool intents only through the separately reviewed engine/financial workflow; a candidate by itself grants neither.

The pure API rejects repeat submission/finalization **on the supplied current state** and rejects a stale supplied revision. An old copied state or a fresh constructor with the same identifiers can still produce the same proposal. There is intentionally no process-global registry; this module cannot enforce cross-worker, cross-process or restart idempotency. Unique database constraints, authenticated lookups and the winning revision CAS are mandatory.

Only the current foundation rate card is available here. A final report naming an unavailable card is retained. Revalidating a saved prepared record after its card or review disappears fails closed; preserve its existing hold and evidence for reconciliation. Do not reprice or reconstruct it under a new current card. An immutable historical rate/review registry and actual provider pricing attribution are separate prerequisites for production recovery.

The current candidate adds an explicit reviewed native-window quoting path, compatible selector pinning, durable attempt persistence and normalized settlement around this pure module. New quotes and candidates pin the 2.5× pricing policy with exact integer arithmetic; missing policy on historical snapshots keeps the original 1.65× arithmetic and fingerprints. Credit value, carry and released DeepSeek execution are preserved. This module alone enables no provider; release/activation checks remain separate.

## Trusted adapter handoff

`adapter-evidence.ts` adds the pure `adapterOutcome(currentState, adapterResult, observedAt)` mapper for the disabled Responses and Anthropic adapters. Their compiled request hash and persisted dispatch timestamp must match the saved prepared/claimed attempt. It preserves the adapter's actual identity/version/profile evidence for contract checks, copies normalized counters separately from quotes, and excludes visible text, native reasoning continuation and diagnostic errors. Failed results remain absent/partial/unverified evidence even if `usageComplete` is true. `providerCostNanoUsd` is not copied into a candidate as an authorized debit. No provider call, mutation, database CAS or ledger bridge is added by this helper.
