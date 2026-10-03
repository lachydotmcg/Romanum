import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Render the actual TSX views offline; the framework Link becomes an ordinary anchor.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") return { url: `data:text/javascript,${encodeURIComponent("export default function Link({href,...props}) { return globalThis.__libraryViewReact.createElement('a',{...props,href}); }")}`, shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(target))) for (const extension of [".ts", ".tsx"]) {
        if (existsSync(fileURLToPath(`${target.href}${extension}`))) return nextResolve(`${target.href}${extension}`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(`import React from 'react';\n${readFileSync(fileURLToPath(url), "utf8")}`, { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText };
    return nextLoad(url, context);
  },
});
globalThis.__libraryViewReact = React;
const { ImageLibraryView, ImageDetailView } = await import("../src/components/image-library/image-library.tsx");
test.after(() => { hooks.deregister(); delete globalThis.__libraryViewReact; });
const query = { q: "", kind: "all", stage: "all", projectId: null, limit: 12, after: null };
const image = {
  id: "b81d572e-bdfc-4564-84a1-e5bd7fb18465", projectId: "c96c6c98-515d-4cb7-9c75-3137bf15e48d", projectName: "Private fixture project",
  title: "<script>owner title</script>", createdAt: "2026-10-02T12:00:00.123456Z", width: 768, height: 512, byteLength: 1200,
  generation: { kind: "thumbnail", stage: "final", provider: "fixture-provider", model: "fixture-model", mode: "test" },
};
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("library cards render private authorized paths, truthful metadata and bounded search/filter controls", () => {
  const markup = render(ImageLibraryView, { query, page: { images: [image], nextCursor: "fixture-cursor" } });
  assert.match(markup, /Image library/);
  assert.match(markup, /Private to you/);
  assert.match(markup, /Test output/);
  assert.match(markup, /maxLength="80"/);
  assert.match(markup, /name="kind"/);
  assert.match(markup, /name="stage"/);
  assert.match(markup, new RegExp(`/api/image-library/${image.id}/file\\?variant=thumbnail`));
  assert.match(markup, /<button type="button" aria-label="Download/);
  assert.match(markup, /Next page/);
  assert.ok(!markup.includes("<script>owner title</script>"));
  assert.ok(!markup.includes("https://"));
});

test("download requests save only successful bounded PNGs and preserve current-session private fetch semantics", async () => {
  const { requestImageDownload } = await import("../src/components/image-library/download-image.tsx");
  const originalFetch = globalThis.fetch;
  try {
    const bytes = new Uint8Array(45);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/api/image-library/${image.id}/file?download=1`);
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    };
    assert.equal((await requestImageDownload(image.id)).size, bytes.length);
    for (const [status, message] of [[401, /Sign in again/], [404, /Image not found/], [410, /no longer available/], [503, /download unavailable/]]) {
      globalThis.fetch = async () => new Response("private storage failure", { status });
      await assert.rejects(requestImageDownload(image.id), message);
    }
    for (const response of [new Response("private API error", { headers: { "Content-Type": "application/json" } }), new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(10 * 1024 * 1024 + 1) } }), new Response(new Uint8Array(1), { headers: { "Content-Type": "image/png" } })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(requestImageDownload(image.id), /download unavailable/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("empty, no-results and unavailable views remain visibly distinct", () => {
  const page = { images: [], nextCursor: null };
  assert.match(render(ImageLibraryView, { query, page }), /No saved generated images/);
  assert.match(render(ImageLibraryView, { query: { ...query, q: "not found" }, page }), /No matching images/);
  const unavailable = render(ImageLibraryView, { query, page, state: "unavailable" });
  assert.match(unavailable, /Image library unavailable/);
  assert.match(unavailable, /Try again/);
  assert.ok(!unavailable.includes("No saved generated images"));
  assert.match(render(ImageLibraryView, { query, page, state: "invalid" }), /Check your filters/);
});

test("detail view escapes the owner's prompt and labels missing lineage and truncated prompts honestly", () => {
  const markup = render(ImageDetailView, { image: { ...image, prompt: "<script>private prompt</script>", promptTruncated: true } });
  assert.match(markup, /Download PNG/);
  assert.match(markup, /Generation details/);
  assert.match(markup, /8,000 characters/);
  assert.ok(!markup.includes("<script>private prompt</script>"));
  assert.match(markup, /&lt;script&gt;private prompt&lt;\/script&gt;/);
  const missing = render(ImageDetailView, { image: { ...image, generation: { ...image.generation, model: null, provider: null, mode: null, stage: null }, prompt: null, promptTruncated: false } });
  assert.match(missing, /A generation prompt was not recorded/);
  assert.match(missing, /Not recorded/);
});
