---
name: romanum-game-economy
description: Plan Roblox progression, currency balance and optional purchases using authorised product data and observed play. Use for economy reviews and monetisation experiments, not revenue guesses from public CCU or pressure tactics aimed at children.
license: "Romanum Source-Available License 1.0; see LICENSE or https://github.com/romanumdev/Romanum/blob/main/LICENSE. Commercial project outputs are permitted."
---

# Roblox game economy

Help the developer offer understandable value while keeping the core game enjoyable without purchases. Start with the intended audience, current loop and the actual problem being investigated.

## Diagnose the loop

Map currency sources, spending sinks, storage caps, unlocks, trading and offline rewards. Separate permanent ownership from temporary benefits and repeat purchases. Use observed earn rates and costs where available; label proposed balancing values as assumptions.

Compare the path of a new player, an experienced non-payer and a player using the proposed benefit. Identify whether a boost skips the next meaningful choice, removes a currency sink or accelerates content exhaustion. Check social effects too: an individual advantage may make competition less enjoyable for everyone else. Fix broken controls, onboarding and unfair losses directly rather than selling relief from them.

## Use the right evidence

With authorised first-party data, inspect product sales, revenue, unique buyers, eligible offer exposures and time windows separately. Sales volume is not revenue or conversion. Account for availability, price changes, traffic/device mix, refunds and repeated buyers. A best seller may simply receive more exposure.

Combine those records with observed player behaviour. An unexpected play style is a research lead, not permission to infer a player's finances or target their vulnerability. Without private data, offer hypotheses and instrumentation; public CCU and Top Earning rankings do not supply a competitor's revenue.

## Design and test an offer

State the benefit, duration, limits, price display and effect on progression. Prefer clear optional upgrades, expression or convenience that preserves meaningful play. Keep the free path and dismiss action visible. Avoid accidental purchase placement, forced shop openings after repeated failure, misleading discounts, false scarcity or spending pressure on younger audiences.

Test one material change with a named baseline, comparable cohort/window, primary outcome and rollback condition. Measure more than receipts: purchase confusion, errors, time to the next meaningful goal, non-payer experience and return behaviour matter. Use the platform's actual metric definitions; correlation after an update is not proof the offer caused it. Report uncertainty and insufficient samples instead of declaring a guaranteed winner.

## Implementation handoff

For Roblox developer products, verify the current [official purchase guidance](https://create.roblox.com/docs/production/monetization/developer-products). Grant purchases through server-side `ProcessReceipt`, with durable duplicate handling and validation; a purchase-prompt closing event is not a successful receipt. Check current rules before paid random rewards or regional offers. Do not enable sales or spend Robux as a side effect of drafting a plan. Roblox's external-purchase test mode can still cost Robux.

Use [Roblox retention definitions](https://create.roblox.com/docs/production/analytics/retention) when evaluating return behaviour. Never silently export private economy data, player identifiers or derived reports into shared examples or skills.

## Sources

Original paraphrases of Tizzy RBLX's monetisation transcript: product data and observed behaviour, 0:55–2:00; economy tradeoffs, 2:23–2:36; progression effects, 8:09–8:24; checking broader results, 14:29–14:53. [Creator channel](https://www.youtube.com/@TizzyRBLX12). Individual video URL/date and reported earnings are unverified. Romanum does not adopt spending-pressure tactics or claims of guaranteed sales. Fair-design and evidence rules above are Romanum guidance; full transcripts are not distributed.
