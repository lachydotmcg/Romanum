import test from "node:test";
import assert from "node:assert/strict";
import { APIConnectionError, APIConnectionTimeoutError, APIError, OpenAI } from "openai";
import { ImageProviderError, MAX_IMAGE_BYTES } from "../src/lib/creative/image-provider.ts";
import {
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  createOpenAIImageProvider,
  openAIImageClientOptions,
} from "../src/lib/creative/openai-image-provider.ts";

// Fixtures are synthetic PNG envelopes: exactly what the contract's bounded
// inspectPng checks. Nothing here decodes an image or reaches the network.
const png = (width = 1, height = 1) => {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  const idat = Buffer.alloc(12);
  idat.write("IDAT", 4, "ascii");
  const iend = Buffer.concat([Buffer.from("IEND", "ascii"), Buffer.alloc(4)]);
  return new Uint8Array(Buffer.concat([header, idat, iend]));
};

const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

const request = (extra = {}) => ({
  prompt: "A flat, dark grey workspace panel.",
  size: "1024x1024",
  quality: "medium",
  transparent: false,
  references: [],
  ...extra,
});

const configuration = (extra = {}) => ({ enabled: true, apiKey: "sk-test-key", model: "gpt-image-1", ...extra });

const payload = (b64 = base64(png()), extra = {}) => ({ created: 0, data: [{ b64_json: b64 }], _request_id: "req_abc123", ...extra });

// A stub client only. It records every call and never opens a socket.
const stub = (result) => {
  const calls = { generate: [], edit: [] };
  const respond = () => (typeof result === "function" ? result() : result);
  return {
    calls,
    client: {
      images: {
        generate: (params, callOptions) => {
          calls.generate.push({ params, callOptions });
          return Promise.resolve().then(respond);
        },
        edit: (params, callOptions) => {
          calls.edit.push({ params, callOptions });
          return Promise.resolve().then(respond);
        },
      },
    },
  };
};

const rejects = async (promise, code) => {
  const error = await promise.then(
    () => assert.fail(`expected ImageProviderError("${code}")`),
    (thrown) => thrown,
  );
  assert.ok(error instanceof ImageProviderError, `expected ImageProviderError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};

test("stays unavailable and rejects before building a client until enabled with a key and a model", async () => {
  const built = [];
  const { calls, client } = stub(payload());
  const build = () => {
    built.push(1);
    return client;
  };
  const provider = createOpenAIImageProvider({}, { client, createClient: build });
  assert.equal(provider.id, "openai");
  assert.equal(provider.mode, "paid");
  assert.equal(provider.available, false);
  assert.equal(provider.model, "");
  await rejects(provider.generate(request()), "disabled");

  const unavailable = [
    { enabled: false, apiKey: "sk-test-key", model: "gpt-image-1" },
    { enabled: true, apiKey: "", model: "gpt-image-1" },
    { enabled: true, apiKey: "   ", model: "gpt-image-1" },
    { enabled: true, apiKey: "sk-test-key" },
    { enabled: true, apiKey: "sk-test-key", model: "" },
    { enabled: true, apiKey: "sk-test-key", model: "   " },
  ];
  for (const options of unavailable) {
    const candidate = createOpenAIImageProvider(options, { createClient: build });
    assert.equal(candidate.available, false, JSON.stringify(options));
    await rejects(candidate.generate(request()), "disabled");
  }

  assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit.length, 0);
  assert.equal(built.length, 0);
});

test("ignores the environment for credentials and never invents a default model", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "sk-env-secret";
  process.env.OPENAI_MODEL = "gpt-image-1";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  });

  const provider = createOpenAIImageProvider();
  assert.equal(provider.available, false);
  assert.equal(provider.model, "");
  await rejects(provider.generate(request()), "disabled");
});

test("accepts the gpt-image family and refuses every other model", async () => {
  const { calls, client } = stub(payload());

  for (const model of ["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2-2026-04-21"]) {
    const provider = createOpenAIImageProvider(configuration({ model }), { client });
    assert.equal(provider.available, true, model);
    assert.equal(provider.model, model);
  }

  for (const model of ["dall-e-2", "dall-e-3", "DALL-E-3", "GPT-Image-2", "gpt-4o", "gpt-image", "gpt-image-"]) {
    const provider = createOpenAIImageProvider(configuration({ model }), { client });
    assert.equal(provider.available, false, model);
    await rejects(provider.generate(request()), "disabled");
  }

  assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit.length, 0);
});

test("sends exactly the documented generate request and returns validated PNG bytes", async () => {
  const bytes = png();
  const { calls, client } = stub(payload(base64(bytes)));
  const provider = createOpenAIImageProvider(configuration(), { client });
  const result = await provider.generate(request({ size: "1536x1024", quality: "high", transparent: true }));

  assert.deepEqual(calls.generate[0].params, {
    model: "gpt-image-1",
    prompt: "A flat, dark grey workspace panel.",
    n: 1,
    size: "1536x1024",
    quality: "high",
    output_format: "png",
    background: "transparent",
  });
  assert.equal(calls.edit.length, 0);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.requestId, "req_abc123");

  const opaque = stub(payload());
  await createOpenAIImageProvider(configuration(), { client: opaque.client }).generate(request({ transparent: false }));
  assert.equal(opaque.calls.generate[0].params.background, "opaque");
});

test("keeps only a short, printable upstream request ID", async () => {
  const cases = [
    ["req_1", "req_1"],
    ["", undefined],
    ["line\nbreak", undefined],
    ["x".repeat(129), undefined],
    [undefined, undefined],
    [12345, undefined],
  ];

  for (const [requestId, expected] of cases) {
    const { client } = stub(payload(base64(png()), { _request_id: requestId }));
    const result = await createOpenAIImageProvider(configuration(), { client }).generate(request());
    assert.equal(result.requestId, expected, `request id ${JSON.stringify(requestId)}`);
    assert.equal("requestId" in result, expected !== undefined);
  }
});

test("passes reference bytes through the SDK edit endpoint as PNG files", async () => {
  const first = png(1, 1);
  const second = png(2, 2);
  const { calls, client } = stub(payload());
  const provider = createOpenAIImageProvider(configuration({ model: "gpt-image-1.5" }), { client });
  const result = await provider.generate(
    request({
      size: "1024x1536",
      quality: "low",
      references: [
        { bytes: first, mimeType: "image/png" },
        { bytes: second, mimeType: "image/png" },
      ],
    }),
  );

  assert.equal(calls.generate.length, 0);
  const [{ params }] = calls.edit;
  assert.deepEqual(Object.keys(params).sort(), ["background", "image", "model", "n", "output_format", "prompt", "quality", "size"]);
  assert.equal(params.model, "gpt-image-1.5");
  assert.equal(params.prompt, "A flat, dark grey workspace panel.");
  assert.equal(params.n, 1);
  assert.equal(params.size, "1024x1536");
  assert.equal(params.quality, "low");
  assert.equal(params.output_format, "png");
  assert.equal(params.background, "opaque");
  assert.equal(params.image.length, 2);
  for (const [index, bytes] of [first, second].entries()) {
    assert.equal(params.image[index].name, `reference-${index + 1}.png`);
    assert.equal(params.image[index].type, "image/png");
    assert.deepEqual(new Uint8Array(await params.image[index].arrayBuffer()), bytes);
  }
  assert.deepEqual(result.bytes, png());
  assert.equal(result.requestId, "req_abc123");
});

test("forbids SDK retries and binds every call to one bounded deadline", async () => {
  assert.ok(
    Number.isInteger(OPENAI_IMAGE_REQUEST_TIMEOUT_MS) && OPENAI_IMAGE_REQUEST_TIMEOUT_MS > 0 && OPENAI_IMAGE_REQUEST_TIMEOUT_MS <= 300_000,
    `unexpected timeout ${OPENAI_IMAGE_REQUEST_TIMEOUT_MS}`,
  );
  assert.deepEqual(openAIImageClientOptions("sk-test-key"), {
    apiKey: "sk-test-key",
    maxRetries: 0,
    timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  });

  // The real SDK client accepts those options, and building it opens no socket.
  const real = new OpenAI(openAIImageClientOptions("sk-test-key"));
  assert.equal(real.maxRetries, 0);
  assert.equal(real.timeout, OPENAI_IMAGE_REQUEST_TIMEOUT_MS);

  let built = 0;
  const { calls, client } = stub(payload());
  const provider = createOpenAIImageProvider(configuration(), {
    createClient: () => {
      built += 1;
      return client;
    },
  });
  await provider.generate(request());
  await provider.generate(request({ references: [{ bytes: png(), mimeType: "image/png" }] }));

  assert.equal(built, 1);
  assert.deepEqual(calls.generate[0].callOptions, { maxRetries: 0, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS });
  assert.deepEqual(calls.edit[0].callOptions, { maxRetries: 0, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS });
  assert.deepEqual(Object.keys(calls.generate[0].callOptions), ["maxRetries", "timeout"]);
});

test("rejects invalid input before the provider is called", async () => {
  const { calls, client } = stub(payload());
  const provider = createOpenAIImageProvider(configuration(), { client });

  await rejects(provider.generate(request({ prompt: "x".repeat(32_001) })), "rejected");
  await rejects(provider.generate(request({ prompt: "   " })), "rejected");
  await rejects(provider.generate(request({ prompt: "" })), "rejected");
  await rejects(
    provider.generate(request({ references: Array.from({ length: 5 }, () => ({ bytes: png(), mimeType: "image/png" })) })),
    "rejected",
  );
  await rejects(provider.generate(request({ references: [{ bytes: new Uint8Array(16), mimeType: "image/png" }] })), "rejected");
  await rejects(
    provider.generate(request({ references: [{ bytes: Buffer.from("not a png"), mimeType: "image/png" }] })),
    "rejected",
  );
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit.length, 0);

  // The full prompt budget and four references are accepted.
  const edge = stub(payload());
  const edgeProvider = createOpenAIImageProvider(configuration(), { client: edge.client });
  await edgeProvider.generate(request({ prompt: "y".repeat(32_000) }));
  await edgeProvider.generate(request({ references: Array.from({ length: 4 }, () => ({ bytes: png(), mimeType: "image/png" })) }));
  assert.equal(edge.calls.generate.length, 1);
  assert.equal(edge.calls.edit.length, 1);
});

test("maps definitive API rejections to rejected without retrying", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let attempts = 0;
    const { client } = stub(() => {
      attempts += 1;
      throw new APIError(status, { message: "refused" }, "refused", undefined);
    });
    const error = await rejects(createOpenAIImageProvider(configuration(), { client }).generate(request()), "rejected");
    assert.equal(error.message, "Image generation could not be completed.");
    assert.equal(error.cause, undefined);
    assert.equal(attempts, 1, `status ${status}`);
  }
});

test("keeps transport, rate limit, server and malformed responses uncertain without fetching a URL", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches += 1;
    throw new Error("network access is disabled in tests");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const failures = [
    new APIConnectionError({ message: "socket closed" }),
    new APIConnectionTimeoutError(),
    new APIError(429, { message: "slow down" }, "slow down", undefined),
    new APIError(500, { message: "server error" }, "server error", undefined),
    new APIError(503, { message: "unavailable" }, "unavailable", undefined),
    Object.assign(new Error("unclassified status"), { status: 409 }),
    new Error("not an SDK error"),
  ];
  for (const failure of failures) {
    const { client } = stub(() => {
      throw failure;
    });
    const error = await rejects(createOpenAIImageProvider(configuration(), { client }).generate(request()), "uncertain");
    assert.equal(error.name, "ImageProviderError");
  }

  const malformed = [
    {},
    { data: null },
    { data: [] },
    { data: [{}] },
    { data: [{ b64_json: 42 }] },
    { data: [{ url: "https://example.invalid/generated.png" }] },
    { data: [{ b64_json: "not base64!" }] },
    { data: [{ b64_json: "AAAA" }] },
    { data: [{ b64_json: base64(new Uint8Array(16)) }] },
    { data: [{ b64_json: base64(png(4096, 4096)) }] },
    { data: [{ b64_json: "A".repeat(MAX_BASE64_CHARS + 4) }] },
  ];
  for (const body of malformed) {
    const { client } = stub({ created: 0, ...body });
    const error = await rejects(createOpenAIImageProvider(configuration(), { client }).generate(request()), "uncertain");
    assert.equal(error.message, "Image generation needs reconciliation.");
  }

  assert.equal(fetches, 0);
});

test("never logs a failure and never leaks the prompt or the key", async (t) => {
  const logged = [];
  const restore = ["log", "info", "warn", "error", "debug"].map((name) => {
    const original = console[name];
    console[name] = (...args) => {
      logged.push(args);
    };
    return () => {
      console[name] = original;
    };
  });
  t.after(() => {
    for (const undo of restore) undo();
  });

  const secretPrompt = "SECRET-PROMPT-TEXT";
  const secretKey = "sk-secret-provider-key";
  const { client } = stub(() => {
    throw new APIError(400, { message: "refused" }, "refused", undefined);
  });
  const provider = createOpenAIImageProvider(configuration({ apiKey: secretKey }), { client });
  const error = await rejects(provider.generate(request({ prompt: secretPrompt })), "rejected");

  assert.equal(error.message, "Image generation could not be completed.");
  assert.ok(!error.message.includes(secretKey));
  assert.ok(!error.message.includes(secretPrompt));
  assert.ok(!(error.stack ?? "").includes(secretKey));
  assert.equal(logged.length, 0);
});
