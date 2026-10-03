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

`ModelStatDiamond` supports Reasoning, Coding, Speed and Value on a shared, documented, higher-is-better 0–100 scale. An evaluation needs a model ID, finite bounded scores, a dated HTTPS source and methodology. Production has no comparable evaluation registry yet; it displays strengths and actual prices. Model family claims and token prices do not become cross-provider scores. Synthetic fixtures exercise chart rendering in tests and are rejected by default, including by `ModelPreview`.
