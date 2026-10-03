# Estimated model profiles — 3 October 2026

These are coarse comparative estimates within the seven matched Romanum models, not measured runtime throughput, task success probabilities or credit quotes. Higher is better. A missing source match is absent, not zero.

## Licensed quality sources

The included `model-rating-evidence.json` contains exact matched rows from [Arena's official leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), published by Arena (`lmarena-ai`) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution and a notice that the rows were adapted into coarse bands appear in the optional Sources disclosure. The dataset's model-license column describes model weights; it is distinct from the dataset's CC BY 4.0 license. No Artificial Analysis scores or externally hosted Epoch rows are redistributed.

Intelligence uses `text_style_control`, `latest`, `overall`, published 2026-10-02. It is a broad human text-preference proxy, so the label is Intelligence rather than a claim to measure reasoning. Coding uses `webdev`, `latest`, `overall`, published 2026-10-01. This is a web-development preference proxy, not a general coding or Roblox/Luau benchmark. Official model guides also document coding use cases; no task-specific coding accuracy is inferred.

Both axes use the same seven model identities, each mapped to an explicit published setting. Opus uses High for text and Max for webdev; Sonnet uses xhigh; Fable and the three OpenAI models use Max; Haiku is the exact plain dated model. Those settings are shown under Sources. Romanum's OpenAI adapter explicitly uses medium; Claude adaptive effort follows provider model defaults. The chart is a source-informed model profile, not a benchmark of those live settings.

For each axis independently, take the matched cohort's minimum and maximum Arena ratings, then calculate `round(1 + 4 * clamp((rating - minimum) / (maximum - minimum), 0, 1))`. This avoids arbitrary per-model quality scores and applies one rule throughout. The bands are heuristic: confidence intervals overlap, and a rounding boundary is not a statistically significant ordering. Raw published confidence intervals are retained for review, but only integer bands appear in the card.

## Speed basis

Speed is a qualitative estimate with one fixed tier vocabulary: 2 slower/deliberate, 3 balanced/moderate, 4 fast, 5 fastest/latency-oriented. No tokens/second or wall-clock values are invented.

- [OpenAI's model-selection guide](https://developers.openai.com/api/docs/guides/model-selection) recommends Luna for low-latency efficient scoped work (5), Sol for complex work while managing time and cost (3), and Astra when latency/cost matter less than capability (2). Cross-provider placement is an estimate from positioning, not a common speed test.
- [Claude's overview](https://platform.claude.com/docs/en/models/overview) explicitly labels Haiku fastest (5), Sonnet fast (4), Opus moderate (3), and Fable slower (2).

These source descriptions were checked on 2026-10-03. Speed also depends on effort, output length, queueing, tools and provider load; none is assumed constant in an actual customer call.

## Value basis

Use a fixed reference call of **10,000 uncached input tokens and 2,000 total output tokens**, without tools, cache reads/writes or batch discounts. Provider cost is `(input USD/MTok * .01) + (output USD/MTok * .002)`, using the model's published standard rates. It is not an estimate of a customer's request or credits, and output includes any charged reasoning tokens within the reference total.

Quality weight is the mean of the Intelligence and Coding bands. Take `log(quality weight / reference provider USD)` and apply the same min/max-to-five-bands normalization within the seven-model cohort. This is a transparent ordinal cost/quality heuristic, not an accuracy-per-dollar measurement. A common markup factor would cancel in this relative log normalization; the browser neither applies a markup nor changes billing policy. The reference prices match the existing catalog, and Value is withheld if the actual DTO input/output rates differ. Missing quality also withholds Value.

Reference rates were checked against the [OpenAI](https://developers.openai.com/api/docs/pricing) and [Claude](https://platform.claude.com/docs/en/about-claude/pricing) price guides and current public catalog on 2026-10-03.

| Model | Intelligence | Coding | Speed | Value | Reference provider USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-6 Luna | 2 | 3 | 5 | 5 | .002 |
| GPT-6.1 Sol | 4 | 5 | 3 | 3 | .040 |
| GPT-6 Astra | 4 | 5 | 2 | 1 | .200 |
| Claude Haiku 4.5 | 1 | 1 | 5 | 2 | .020 |
| Claude Sonnet 5.5 | 4 | 5 | 4 | 3 | .040 |
| Claude Opus 5.5 | 5 | 5 | 3 | 2 | .080 |
| Claude Fable 5.1 | 5 | 4 | 2 | 1 | .200 |
| DeepSeek Flash | — | — | — | — | — |
| DeepSeek V4 Pro | — | — | — | — | — |

DeepSeek Flash's runtime alias is not matched to a verified benchmark version, and the Pro benchmark row has a specific version suffix that the runtime contract does not establish. Neither borrows V4.1 Flash or 0813 scores. Their existing qualitative capability chips and exact catalog prices remain available. A partial profile draws individual known points and announces missing axes; it does not close a polygon through zero.
