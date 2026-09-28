import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import OpenAI from "openai";
import { createServer } from "node:http";
import { once } from "node:events";
import { meteredStream } from "../src/lib/assistant/billing.ts";
import { normalizeChatImage, ImageInputError } from "../src/lib/chats/image-input.ts";
import { withReferenceImages } from "../src/lib/chats/vision.ts";
import { messageText } from "../src/lib/assistant/message-text.ts";

const fixture = (width = 32, height = 16) => sharp({ create: { width, height, channels: 4, background: { r: 30, g: 40, b: 50, alpha: 0.5 } } });

test("PNG, JPEG and WebP uploads decode to bounded WebP without private metadata", async () => {
  for (const format of ["png", "jpeg", "webp"]) {
    const bytes = await fixture()[format]().withExif({ IFD0: { Artist: "Private artist", ImageDescription: "Private metadata" } }).toBuffer();
    const normalized = await normalizeChatImage(bytes);
    const metadata = await sharp(normalized.bytes).metadata();
    assert.equal(normalized.mimeType, "image/webp");
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 16);
    for (const key of ["exif", "xmp", "icc", "iptc"]) assert.equal(metadata[key], undefined);
    assert.ok(!Buffer.from(normalized.bytes).includes(Buffer.from("Private metadata")));
  }
});

test("normalization preserves transparency, resizes large inputs and applies orientation", async () => {
  const wide = await normalizeChatImage(await fixture(2400, 1200).png().toBuffer());
  const metadata = await sharp(wide.bytes).metadata();
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.hasAlpha, true);
  const rotated = await normalizeChatImage(await fixture(100, 50).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const orientation = await sharp(rotated.bytes).metadata();
  assert.equal(orientation.width, 50);
  assert.equal(orientation.height, 100);
  assert.equal(orientation.orientation, undefined);
});

test("malformed images, unsupported formats, oversize bytes and excessive dimensions fail closed", async () => {
  const valid = await fixture().png().toBuffer();
  const cases = [Buffer.alloc(0), valid.subarray(0, 24), Buffer.from([255,216,255,224]), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>"), Buffer.concat([valid, Buffer.alloc(5 * 1024 * 1024)]), await fixture(8193, 1).png().toBuffer(), await fixture(4096, 4096).png().toBuffer()];
  for (const bytes of cases) await assert.rejects(normalizeChatImage(bytes), ImageInputError);
});

test("vision payload keeps the text and ordered current images; no images leaves text unchanged", async () => {
  const question = { role: "user", content: "Compare these thumbnails" };
  assert.equal(withReferenceImages(question, []), question);
  const first = await normalizeChatImage(await fixture().png().toBuffer());
  const second = await normalizeChatImage(await fixture(10, 10).png().toBuffer());
  const message = withReferenceImages(question, [first, second]);
  assert.equal(message.role, "user");
  assert.equal(message.content.length, 3);
  assert.equal(message.content[0].text, question.content);
  assert.equal(message.content[1].image_url.url, `data:image/webp;base64,${Buffer.from(first.bytes).toString("base64")}`);
  assert.equal(message.content[2].image_url.detail, "high");
  assert.equal(messageText(message), question.content);
  assert.equal(messageText(undefined), "");
  assert.throws(() => withReferenceImages(question, [first, first, first, first]));
  assert.throws(() => withReferenceImages({ role: "assistant", content: "Hi" }, [first]));
});

test("animated WebP is rejected instead of silently reviewing only one frame", async () => {
  const raw = Buffer.from([...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 255]).flat()]);
  const animation = await sharp(raw, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages, 2);
  await assert.rejects(normalizeChatImage(animation), ImageInputError);
});

test("the SDK sends normalized inline images and settles the provider's image-inclusive usage", async (t) => {
  let received;
  let settled;
  let reserved = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = { id: "test-completion", object: "chat.completion.chunk", created: 0, model: "deepseek-flash", choices: [{ index: 0, delta: { content: "Test response" }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210 } };
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const client = new OpenAI({ apiKey: "test-only", baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 });
  const image = await normalizeChatImage(await fixture().png().toBuffer());
  const message = withReferenceImages({ role: "user", content: "Review this UI" }, [image]);
  const billing = { credits: 0, async reserve() { reserved = true; return "test-hold"; }, async settle(id, call) { assert.ok(reserved); settled = call; }, async finish() { assert.fail("usage should settle"); } };
  const chunks = [];
  for await (const chunk of meteredStream(client, { model: "deepseek-flash", messages: [message], max_tokens: 100, stream: true, stream_options: { include_usage: true } }, billing, new AbortController().signal)) chunks.push(chunk);
  assert.equal(received.messages[0].content[0].text, "Review this UI");
  assert.equal(received.messages[0].content[1].image_url.url, message.content[1].image_url.url);
  assert.equal(settled.input, 1200);
  assert.equal(settled.output, 10);
  assert.equal(chunks[0].choices[0].delta.content, "Test response");
});
