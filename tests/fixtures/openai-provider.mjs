// Synthetic wire-shaped Responses fixtures; no recordings, secrets or provider calls.
export const at = "2026-10-03T07:00:00.000Z";
export const models = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
export const tool = { name: "fixture_lookup", description: "Look up a synthetic example", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
export const request = (extra = {}) => ({ modelId: models[0], system: "Use synthetic examples only.",
  messages: [{ role: "user", content: "Inspect the fixture." }], tools: [tool], maxTokens: 100, maxInputTokens: 2000, ...extra });
export const usage = (extra = {}) => ({ input_tokens: 1000, output_tokens: 100, total_tokens: 1100,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, output_tokens_details: { reasoning_tokens: 70 }, ...extra });
export const text = (value = "Synthetic café response.") => ({ type: "message", id: "msg_fixture_1", role: "assistant",
  status: "completed", phase: "final_answer", content: [{ type: "output_text", text: value, annotations: [] }] });
export const reasoning = () => ({ type: "reasoning", id: "rs_fixture_1", summary: [], encrypted_content: "synthetic_opaque_reasoning" });
export const call = (extra = {}) => ({ type: "function_call", id: "fc_fixture_1", call_id: "call_fixture_1",
  name: tool.name, arguments: '{"query":"synthetic example"}', status: "completed", ...extra });
export const envelope = (extra = {}) => ({ object: "response", id: "resp_fixture_1", model: models[0], status: "completed",
  error: null, incomplete_details: null, store: false, service_tier: "default", background: false,
  output: [reasoning(), text()], usage: usage(), ...extra });
export function response(value, { chunkBytes = 7, contentType = "application/json" } = {}) {
  const data = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= data.length) return controller.close();
    controller.enqueue(data.slice(offset, offset + chunkBytes)); offset += chunkBytes;
  } }), { headers: { "Content-Type": contentType } });
}
