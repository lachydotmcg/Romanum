import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { publicModels, RELEASED_EXECUTION_REVIEWS } from "../src/lib/models/readiness.ts";
import { routeModel } from "../src/lib/models/route.ts";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const hookUrl = new URL("../src/components/models/use-model-catalog.ts", import.meta.url).href;
const virtual = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/src/") && specifier.startsWith("next/") && !path.extname(specifier)) return next(`${specifier}.js`, context);
    if (context.parentURL === hookUrl && specifier === "react") return virtual(`import * as React from ${JSON.stringify(import.meta.resolve("react"))};
      ${["useState", "useRef", "useCallback", "useEffect"].map(name => `export function ${name}(...args){return globalThis.__modelCatalogHooks?globalThis.__modelCatalogHooks.${name}(...args):React.${name}(...args);}`).join("\n")}`);
    if (specifier.endsWith(".css")) return virtual("export default {};");
    if (specifier.startsWith("@/")) {
      const base = path.resolve(root, specifier.slice(2));
      const candidate = [base, `${base}.ts`, `${base}.tsx`].find(file => existsSync(file) && statSync(file).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(pathToFileURL(root).href) && specifier.startsWith(".") && !path.extname(specifier)) {
      const url = new URL(specifier, context.parentURL), file = fileURLToPath(url);
      const candidate = [`${file}.ts`, `${file}.tsx`].find(file => existsSync(file));
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText };
    return next(url, context);
  },
});
const { useModelCatalog, selectionEnabled } = await import(hookUrl);
const { replayChatMessages } = await import("../src/components/chats/chat-view.tsx");
const { Composer } = await import("../src/components/chats/composer.tsx");
const { Transcript } = await import("../src/components/assistant/transcript.tsx");
const { applyEvent, newTurn } = await import("../src/components/assistant/turns.ts");
hooks.deregister();

// Explicit disabled reviews exercise metadata refresh and unavailable-choice behavior.
const catalog = publicModels({ DEEPSEEK_API_KEY: "fixture-only", OPENAI_API_KEY: "fixture-only", ANTHROPIC_API_KEY: "fixture-only" },
  Object.fromEntries(Object.entries(RELEASED_EXECUTION_REVIEWS).map(([id, review]) => [id, { ...review, executionEnabled: id === "deepseek-flash" }])));
const resolvedAt = "2026-10-02T12:00:00.000Z";
const decision = selection => routeModel({ selection, availableCredits: 100, at: resolvedAt,
  budget: { inputTokens: 1000, maxInputTokens: 2000, outputTokens: 500, maxOutputTokens: 1000 } }, catalog.models);
const proposal = selection => ({ type: "model_selection", modelSelection: selection, decision: decision(selection), resolvedAt });

test("replay restores the requested mode and actual model; an unexecuted proposal never claims actual execution", () => {
  for (const selection of [{ mode: "auto" }, { mode: "explicit", modelId: "deepseek-flash" }]) {
    const messages = [{ id: "question", role: "user", content: "Fixture question", attachments: [] },
      { id: "answer", role: "assistant", events: [{ t: 0, e: proposal(selection) }, { t: 1, e: { type: "model", modelId: "deepseek-flash" } }, { t: 2, e: { type: "text", delta: "Fixture answer" } }, { t: 3, e: { type: "done", messages: [] } }] }];
    const [turn] = replayChatMessages(messages);
    assert.deepEqual(turn.modelSelection, selection); assert.equal(turn.actualModel, "deepseek-flash");
    assert.equal(turn.modelResolvedAt, resolvedAt); assert.equal(turn.done, true);
    const html = renderToStaticMarkup(React.createElement(Transcript, { turns: [turn] }));
    assert.match(html, selection.mode === "auto" ? /DeepSeek Flash.*Auto/ : /DeepSeek Flash.*Your choice/);
    const stopped = replayChatMessages([messages[0], { ...messages[1], events: [{ t: 0, e: proposal(selection) }, { t: 1, e: { type: "error", message: "Stopped." } }] }])[0];
    assert.deepEqual(stopped.modelSelection, selection); assert.equal(stopped.actualModel, undefined);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(Transcript, { turns: [stopped] })), /DeepSeek Flash/);
  }
  const legacy = replayChatMessages([{ id: "legacy", role: "user", content: "Legacy", attachments: [] }, { role: "assistant", events: [{ t: 1, e: { type: "text", delta: "Legacy answer" } }] }])[0];
  assert.equal(legacy.modelSelection, undefined); assert.equal(legacy.actualModel, undefined);
  const legacyReported = applyEvent(applyEvent(legacy, { ...proposal({ mode: "explicit", modelId: "deepseek-flash" }), decision: null, legacy: true }, 0), { type: "model", modelId: "deepseek-flash" }, 1);
  assert.match(renderToStaticMarkup(React.createElement(Transcript, { turns: [legacyReported] })), /DeepSeek Flash.*Legacy/);
});

test("malformed metadata and a model contradicting its saved decision cannot alter replayed selection", () => {
  const turn = applyEvent(newTurn("fixture", "Question"), proposal({ mode: "auto" }), 0);
  assert.equal(applyEvent(turn, { type: "model", modelId: "gpt-6-astra" }, 1).actualModel, undefined);
  assert.deepEqual(applyEvent(turn, { type: "model_selection", modelSelection: { mode: "forged" }, resolvedAt }, 1), turn);
  assert.deepEqual(applyEvent(turn, { type: "model_selection", modelSelection: { mode: "auto" }, resolvedAt: "invalid" }, 1), turn);
});

test("real composer SSR uses the controlled pill, preserves choice and disables send while unavailable or running", () => {
  for (const selection of [{ mode: "auto" }, { mode: "explicit", modelId: "deepseek-flash" }, { mode: "explicit", modelId: "gpt-6.1-sol" }]) {
    const models = { catalog, selection, setSelection() {}, loading: false, error: null, canSend: selectionEnabled(catalog, selection) };
    const html = renderToStaticMarkup(React.createElement(Composer, { models, connected: true, running: false, initialText: "Fixture question", onSend() {}, onStop() {} }));
    assert.match(html, /role="combobox"/); assert.match(html, /aria-haspopup="listbox"/);
    assert.match(html, selection.mode === "auto" ? />Auto</ : selection.modelId === "deepseek-flash" ? />DeepSeek Flash</ : />GPT-6.1 Sol</);
    assert.equal(/disabled="" aria-label="Send"/.test(html), !models.canSend);
    assert.doesNotMatch(html, /fixture-only|API_KEY/);
  }
  const html = renderToStaticMarkup(React.createElement(Composer, { models: { catalog, selection: { mode: "auto" }, canSend: true }, connected: true, running: true, onSend() {}, onStop() {} }));
  assert.match(html, /disabled="".*role="combobox"|role="combobox"[^>]*disabled=""/);
  assert.match(html, /aria-label="Stop"/);
});

test("client readiness cannot enable configured but unreviewed providers or conflicting metadata", () => {
  assert.equal(selectionEnabled(catalog, { mode: "auto" }), true);
  for (const model of catalog.models) assert.equal(selectionEnabled(catalog, { mode: "explicit", modelId: model.id }), model.id === "deepseek-flash");
  assert.equal(selectionEnabled({ ...catalog, models: [...catalog.models, catalog.models[0]] }, { mode: "auto" }), false);
  assert.equal(selectionEnabled(null, { mode: "auto" }), false);
});

test("catalog refresh, key removal, stale responses and sanitized failures preserve explicit choice", async t => {
  const states = [], effects = [], pending = [], listeners = new Map(); let cursor = 0;
  const original = { hooks: globalThis.__modelCatalogHooks, window: globalThis.window, fetch: globalThis.fetch };
  t.after(() => { for (const value of states) value?.cleanup?.(); for (const [key, value] of [["__modelCatalogHooks", original.hooks], ["window", original.window], ["fetch", original.fetch]]) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const slot = initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return index; };
  globalThis.__modelCatalogHooks = {
    useState(initial) { const index = slot(initial); return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { return states[slot({ current: initial })]; },
    useCallback(fn) { return states[slot(fn)]; },
    useEffect(effect) { const index = slot(null); if (!states[index]) effects.push(() => { states[index] = { cleanup: effect() }; }); },
  };
  globalThis.window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  globalThis.fetch = (url, init) => new Promise(resolve => pending.push({ url, init, resolve }));
  const selection = { mode: "explicit", modelId: "deepseek-flash" };
  const CatalogFixture = () => { cursor = 0; const state = useModelCatalog(selection); while (effects.length) effects.shift()(); return state; };
  const draw = CatalogFixture;
  const respond = async (request, value, ok = true) => { request.resolve({ ok, json: async () => value }); await new Promise(resolve => setImmediate(resolve)); };
  let state = draw(); assert.equal(state.loading, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[0].url, "/api/models"); assert.equal(pending[0].init.cache, "no-store");
  await respond(pending[0], catalog); state = draw(); assert.equal(state.canSend, true);
  listeners.get("focus")(); state = draw(); assert.equal(state.loading, true);
  const stale = pending[1]; listeners.get("focus")(); assert.equal(stale.init.signal.aborted, true);
  const unavailable = { ...catalog, models: catalog.models.map(model => ({ ...model, configured: false, selectable: false, reason: "missing_key" })) };
  await respond(pending[2], unavailable); state = draw(); assert.equal(state.canSend, false); assert.deepEqual(state.selection, selection);
  await respond(stale, catalog); state = draw(); assert.equal(state.canSend, false);
  listeners.get("focus")(); await respond(pending[3], { error: "secret diagnostic" }, false); state = draw();
  assert.deepEqual(state.selection, selection); assert.doesNotMatch(state.error, /secret|diagnostic/);
  listeners.get("focus")(); await respond(pending[4], catalog); state = draw(); assert.equal(state.canSend, true);
  state.setSelection({ mode: "auto" }); assert.deepEqual(draw().selection, { mode: "auto" });
});
