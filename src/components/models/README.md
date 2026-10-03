# Compact model information

The selector keeps its compact rows and composer layout. Mouse hover opens a hoverable card beside the picker; keyboard users enter it with Right Arrow and browse all model profiles with Up/Down or Home/End. Escape or Close restores the selector focus. Touch uses a bounded bottom sheet: unavailable rows open information, and the picker header's information button opens the current profile. Inspecting a profile never selects, enables or executes a model.

Profiles use the existing public catalog's capabilities, official model links and provider prices in USD per million tokens. Input, output and cache-read rates stay separate. Credit estimates appear only for an actual matching server quote and rate-card version, for that call. The browser does not derive credits from token rates, invent cache-write prices or change billing, reservations, routing or cache policy.

Qualitative task descriptions were checked on 2026-10-03 against these primary model guides:

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): focused, high-volume tasks.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): complex coding and professional work.
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): complex reasoning, coding and research.
- [Claude model overview](https://platform.claude.com/docs/en/models/overview): Haiku for quick everyday work, Sonnet for coding with speed in mind, Opus for long coding and knowledge workflows, Fable for demanding reasoning and long workflows.
- DeepSeek descriptions reflect the catalog's documented text/image/tool capabilities, without comparative performance claims.

The optional Sources disclosure contains source links and dates. Provider asset provenance and retained notices are in [the provider marks README](../../../public/brand/providers/README.md).

Estimated profiles use coarse, explicitly estimated 1–5 Intelligence, Coding, Speed and Value bands. Source settings, dates, attribution and method are under Sources; the full basis is in [RATINGS.md](RATINGS.md). Unknown versions retain qualitative strengths and prices rather than zero or borrowed scores. A changed reference price withholds only Value. Inspecting a profile preserves the model choice and execution readiness. The preview hook is delivered separately for the pricing worker to integrate, because that worker owns the same preview file.

The separate `ModelStatDiamond` supports future shared-scale 0–100 evaluations with a model ID, finite bounded scores, dated HTTPS source and methodology. Synthetic fixtures remain test-only and are rejected by default.
