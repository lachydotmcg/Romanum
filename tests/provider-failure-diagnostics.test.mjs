import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIAdapter } from "../src/lib/models/providers/openai.ts";
import { createAnthropicAdapter } from "../src/lib/models/providers/anthropic.ts";
import * as openai from "./fixtures/openai-provider.mjs";
import * as anthropic from "./fixtures/anthropic-provider.mjs";

// Synthetic failures only. No provider transport, environment changes or database.
const privateText = "PRIVATE_TRANSPORT_DETAIL https://private-host.invalid:1234/private?key=synthetic-secret";
const providers = [
  { name: "openai", create: createOpenAIAdapter, request: () => openai.request(), contentType: "application/json",
    success: () => openai.response(openai.envelope()), malformed: () => openai.response('{"object":'),
    mismatch: () => openai.response(openai.envelope({ model: "gpt-6-astra" })) },
  { name: "anthropic", create: createAnthropicAdapter, request: () => anthropic.request({ stream: true }), contentType: "text/event-stream",
    success: () => anthropic.responseFrom(anthropic.sse(anthropic.textEvents("Synthetic diagnostic fixture."))),
    malformed: () => anthropic.responseFrom('event: message_start\ndata: {"type":\n\n'),
    mismatch: () => anthropic.responseFrom(anthropic.sse([anthropic.start({ model: "claude-opus-5-5" })])) },
];
function harness(provider, fetcher, extra = {}) {
  let attempts = 0;
  const adapter = provider.create({ executionEnabled: true, getApiKey: () => "synthetic-only-key", now: () => openai.at,
    timeoutMs: 1000, fetch: (...args) => { attempts++; return fetcher(...args); }, ...extra });
  return { adapter, attempts: () => attempts };
}
function failed(result, diagnostic, submission = "uncertain") {
  assert.equal(result.status, "failed");
  assert.equal(result.submission, submission);
  assert.deepEqual(result.diagnostic, diagnostic);
  assert.equal(result.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRANSPORT_DETAIL|private-host|synthetic-secret|synthetic-only-key|https:\/\//);
}
function transportError(code) {
  const cause = new Error(privateText);
  Object.defineProperty(cause, "code", { value: code, enumerable: true });
  const middle = new Error(privateText, { cause });
  return new TypeError(privateText, { cause: middle });
}
function bodyFailure(provider, error) {
  return new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { "content-type": provider.contentType } });
}

test("both native adapters classify bounded nested transport codes without changing uncertain single-attempt accounting", async () => {
  const cases = [
    ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "connect"], ["ENETUNREACH", "connect"], ["EHOSTUNREACH", "connect"], ["UND_ERR_CONNECT_TIMEOUT", "connect"],
    ["CERT_HAS_EXPIRED", "tls"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["ECONNRESET", "connection_reset"], ["EPIPE", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
    ["ETIMEDOUT", "transport_timeout"], ["UND_ERR_HEADERS_TIMEOUT", "transport_timeout"], ["UND_ERR_BODY_TIMEOUT", "transport_timeout"],
    ["ABORT_ERR", "aborted"],
  ];
  for (const provider of providers) for (const [transportCode, causeClass] of cases) {
    const h = harness(provider, async () => { throw transportError(transportCode); });
    const result = await h.adapter.complete(provider.request());
    failed(result, { phase: "fetch", causeClass, transportCode });
    assert.equal(result.code, "network_error");
    assert.equal(h.attempts(), 1, `${provider.name} ${transportCode} must not retry`);
  }
});

test("body transport failures report the observed read phase, including nested socket and body timeout causes", async () => {
  for (const provider of providers) for (const [transportCode, causeClass] of [["ECONNRESET", "connection_reset"], ["UND_ERR_BODY_TIMEOUT", "transport_timeout"]]) {
    const h = harness(provider, async () => bodyFailure(provider, transportError(transportCode)));
    failed(await h.adapter.complete(provider.request()), { phase: "response_body", causeClass, transportCode });
    assert.equal(h.attempts(), 1);
  }
});

test("generic fetch and body exceptions stay unknown and never copy unrecognized transport codes", async () => {
  for (const provider of providers) for (const phase of ["fetch", "response_body"]) {
    for (const error of [new Error(privateText), transportError("PRIVATE_UNRECOGNIZED_CODE")]) {
      const h = harness(provider, async () => { if (phase === "fetch") throw error; return bodyFailure(provider, error); });
      failed(await h.adapter.complete(provider.request()), { phase, causeClass: "unknown" });
      assert.equal(h.attempts(), 1);
    }
  }
});

test("actual DOM abort exceptions are classified without treating arbitrary names or messages as evidence", async () => {
  for (const provider of providers) {
    const h = harness(provider, async () => { throw new DOMException(privateText, "AbortError"); });
    failed(await h.adapter.complete(provider.request()), { phase: "fetch", causeClass: "aborted" });
    assert.equal(h.attempts(), 1);
    const forged = new Error(privateText); forged.name = "AbortError";
    const unknown = harness(provider, async () => { throw forged; });
    failed(await unknown.adapter.complete(provider.request()), { phase: "fetch", causeClass: "unknown" });
    assert.equal(unknown.attempts(), 1);
  }
});

test("disabled execution, invalid requests and pre-dispatch abort keep not_submitted diagnostics", async () => {
  for (const provider of providers) {
    const disabled = harness(provider, async () => { assert.fail("Disabled request reached transport"); }, { executionEnabled: false });
    failed(await disabled.adapter.complete(provider.request()), { phase: "pre_dispatch", causeClass: "adapter_rejected" }, "not_submitted");
    assert.equal(disabled.attempts(), 0);
    const invalid = harness(provider, async () => { assert.fail("Invalid request reached transport"); });
    failed(await invalid.adapter.complete({ ...provider.request(), maxTokens: 0 }), { phase: "pre_dispatch", causeClass: "adapter_rejected" }, "not_submitted");
    assert.equal(invalid.attempts(), 0);
    const abort = new AbortController(); abort.abort();
    const cancelled = harness(provider, async () => { assert.fail("Pre-cancelled request reached transport"); });
    failed(await cancelled.adapter.complete(provider.request(), { signal: abort.signal }), { phase: "pre_dispatch", causeClass: "aborted" }, "not_submitted");
    assert.equal(cancelled.attempts(), 0);
  }
});

test("HTTP status and parse/model validation failures identify observed response phases without provider bodies", async () => {
  for (const provider of providers) {
    for (const status of [401, 429, 500]) {
      const h = harness(provider, async () => new Response(privateText, { status }));
      failed(await h.adapter.complete(provider.request()), { phase: "response_headers", causeClass: "provider_status" });
      assert.equal(h.attempts(), 1);
    }
    const headers = harness(provider, async () => new Response(privateText, { headers: { "content-type": "text/html" } }));
    failed(await headers.adapter.complete(provider.request()), { phase: "response_headers", causeClass: "adapter_rejected" });
    assert.equal(headers.attempts(), 1);
    for (const fetcher of [provider.malformed, provider.mismatch]) {
      const h = harness(provider, async () => fetcher());
      failed(await h.adapter.complete(provider.request()), { phase: "response_validation", causeClass: "adapter_rejected" });
      assert.equal(h.attempts(), 1);
    }
  }
});

test("adapter deadlines and caller cancellation retain uncertainty in the observed fetch or body phase", async () => {
  for (const provider of providers) for (const phase of ["fetch", "response_body"]) {
    const pendingTransport = async () => phase === "fetch" ? new Promise(() => {})
      : new Response(new ReadableStream({}), { headers: { "content-type": provider.contentType } });
    const deadline = harness(provider, pendingTransport, { timeoutMs: 10 });
    const timedOut = await deadline.adapter.complete(provider.request());
    failed(timedOut, { phase, causeClass: "deadline" });
    assert.equal(timedOut.code, "timeout"); assert.equal(deadline.attempts(), 1);
    const abort = new AbortController(), cancelled = harness(provider, pendingTransport);
    const promise = cancelled.adapter.complete(provider.request(), { signal: abort.signal });
    const timer = setTimeout(() => abort.abort(), 10);
    try {
      const result = await promise;
      failed(result, { phase, causeClass: "aborted" });
      assert.equal(result.code, "cancelled"); assert.equal(cancelled.attempts(), 1);
    } finally { clearTimeout(timer); }
  }
});

test("Anthropic provisional text consumer failures are classified separately and cannot leak callback errors", async () => {
  const provider = providers[1], h = harness(provider, async () => provider.success());
  const result = await h.adapter.complete(provider.request(), { onText: () => { throw new Error(privateText); } });
  failed(result, { phase: "response_consumer", causeClass: "consumer" });
  assert.equal(h.attempts(), 1);
});

test("cause traversal ignores accessors, cycles and overlong chains while retaining recognized data properties", async () => {
  for (const provider of providers) {
    let reads = 0;
    const accessor = {};
    for (const key of ["message", "name", "stack", "code", "cause"]) Object.defineProperty(accessor, key, {
      enumerable: true, get: () => { reads++; throw new Error(privateText); },
    });
    const getter = harness(provider, async () => { throw accessor; });
    failed(await getter.adapter.complete(provider.request()), { phase: "fetch", causeClass: "unknown" });
    assert.equal(reads, 0); assert.equal(getter.attempts(), 1);
    const cyclic = { message: privateText }; cyclic.cause = cyclic;
    const cycle = harness(provider, async () => { throw cyclic; });
    failed(await cycle.adapter.complete(provider.request()), { phase: "fetch", causeClass: "unknown" });
    let long = { code: "ENOTFOUND", message: privateText };
    for (let i = 0; i < 1000; i++) long = { cause: long, message: privateText };
    const deep = harness(provider, async () => { throw long; });
    failed(await deep.adapter.complete(provider.request()), { phase: "fetch", causeClass: "unknown" });
    const inherited = Object.create({ code: "ENOTFOUND" });
    const prototype = harness(provider, async () => { throw inherited; });
    failed(await prototype.adapter.complete(provider.request()), { phase: "fetch", causeClass: "unknown" });
  }
});
