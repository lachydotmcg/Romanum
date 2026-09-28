import test from "node:test";
import assert from "node:assert/strict";
import { runAssistant } from "../src/lib/assistant/engine.ts";

test("a finished answer makes no extra prediction call or credit reservation", async () => {
  const requests = [], charges = [], events = [];
  const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 };
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    return (async function* () {
      yield { choices: [{ delta: { content: "For the pet racing game, prototype one short race first." } }] };
      yield { choices: [], usage };
    })();
  } } } };
  await runAssistant({
    client,
    conversation: [{ role: "user", content: "Help me plan a +1 pet racing game." }],
    signal: new AbortController().signal,
    send: event => events.push(event),
    billing: {
      credits: 0,
      reserve: async () => { charges.push("reserve"); return "answer"; },
      settle: async () => charges.push("settle"),
      finish: async () => assert.fail("reported usage must settle"),
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.deepEqual(charges, ["reserve", "settle"]);
  assert.deepEqual(events.map(event => event.type), ["text", "done"]);
  assert.equal(events.at(-1).messages[0].content, "For the pet racing game, prototype one short race first.");
});
