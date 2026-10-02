// Synthetic wire-shaped fixtures. No recorded requests, customer content or provider calls.
export const modelId = "claude-haiku-4-5-20251001";
export const at = "2026-10-02T13:30:00.000Z";
export const tool = { name: "fixture_lookup", description: "Search synthetic examples", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
export const request = (extra = {}) => ({ modelId, system: "Use synthetic examples only.",
  messages: [{ role: "user", content: "Inspect the fixture." }], tools: [tool], maxTokens: 100, maxInputTokens: 2000, ...extra });
export const usage = (extra = {}) => ({ input_tokens: 200, output_tokens: 1,
  cache_read_input_tokens: 300, cache_creation_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
  service_tier: "standard", inference_geo: "global", ...extra });
export const start = (extra = {}) => ({ type: "message_start", message: { id: "msg_fixture_1", type: "message", role: "assistant",
  model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: usage(), ...extra } });
export const block = (index, content_block) => ({ type: "content_block_start", index, content_block });
export const delta = (index, delta) => ({ type: "content_block_delta", index, delta });
export const close = (index) => ({ type: "content_block_stop", index });
export const finish = (stop_reason = "end_turn", output_tokens = 20) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } }, { type: "message_stop" },
];
export const textEvents = (text = "Fixture café 🏛.") => [start(), block(0, { type: "text", text: "" }),
  delta(0, { type: "text_delta", text }), close(0), ...finish()];
export const toolEvents = (json = '{"query":"synthetic sample"}', stop = "tool_use") => [start(),
  block(0, { type: "text", text: "Checking fixtures. " }), close(0),
  block(1, { type: "tool_use", id: "toolu_fixture_1", name: tool.name, input: {} }),
  ...[json.slice(0, 5), json.slice(5)].map(partial_json => delta(1, { type: "input_json_delta", partial_json })),
  close(1), ...finish(stop)];
export const sse = (events, ending = "\n") => events.map(event => `event: ${event.type}${ending}data: ${JSON.stringify(event)}${ending}${ending}`).join("");
export function responseFrom(text, { chunkBytes = 4096, contentType = "text/event-stream", cancel = () => {} } = {}) {
  const encoded = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= encoded.length) return controller.close();
    controller.enqueue(encoded.slice(offset, offset + chunkBytes)); offset += chunkBytes;
  }, cancel }), { headers: { "Content-Type": contentType } });
}
export const jsonMessage = (extra = {}) => ({ id: "msg_fixture_1", type: "message", role: "assistant", model: modelId,
  content: [{ type: "text", text: "Synthetic response." }], stop_reason: "end_turn", stop_sequence: null,
  usage: usage({ output_tokens: 20 }), ...extra });
