import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { coarseBand, estimatedModelProfile } from "../src/components/models/model-ratings.ts";
import { publicModels } from "../src/lib/models/readiness.ts";

const url = new URL("../src/components/models/estimated-model-card.tsx", import.meta.url).href;
const hooks = registerHooks({ load(target, context, next) {
  return target === url ? { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(target), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText } : next(target, context);
} });
const { EstimatedModelDiamond, EstimatedProfileSources, AutoModelRange } = await import(url); hooks.deregister();
const catalog = publicModels({ DEEPSEEK_API_KEY: "fixture-only" });
const model = id => catalog.models.find(row => row.id === id);
const html = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test("published cohort produces bounded five-band profiles with dated exact test settings", () => {
  const profiles = catalog.models.map(estimatedModelProfile).filter(profile => profile.evidence);
  assert.equal(profiles.length, 7);
  for (const profile of profiles) for (const score of Object.values(profile.scores)) assert.ok(Number.isInteger(score) && score >= 1 && score <= 5);
  const sol = estimatedModelProfile(model("gpt-6.1-sol"));
  assert.deepEqual(sol.scores, { intelligence: 4, coding: 5, speed: 3, value: 3 });
  assert.equal(sol.evidence.intelligence.model_name, "gpt-6.1-sol-max");
  assert.equal(sol.evidence.coding.leaderboard_publish_date, "2026-10-01");
  const opus = estimatedModelProfile(model("claude-opus-5-5"));
  assert.equal(opus.evidence.intelligence.model_name, "claude-opus-5.5-high");
  assert.equal(opus.evidence.coding.model_name, "claude-opus-5.5-max");
});
test("Value has a defined provider-dollar workload and is withheld when rates change", () => {
  const sol = model("gpt-6.1-sol"), profile = estimatedModelProfile(sol);
  assert.ok(Math.abs(profile.referenceCostUsd - .04) < 1e-12);
  assert.equal(estimatedModelProfile(model("gpt-6-luna")).scores.value, 5);
  const changed = estimatedModelProfile({ ...sol, rates: { ...sol.rates, output: 11 } });
  assert.equal(changed.scores.value, null); assert.equal(changed.referenceCostUsd, undefined);
  assert.equal(changed.scores.intelligence, profile.scores.intelligence);
});
test("unmatched DeepSeek versions and unknown models never get borrowed or zero ratings", () => {
  for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
    const profile = estimatedModelProfile(model(id));
    assert.ok(Object.values(profile.scores).every(value => value === null));
    assert.equal(html(EstimatedModelDiamond, { profile }), "");
  }
  assert.equal(estimatedModelProfile({ id: "gpt-6-sol", rates: { input: 2, output: 10 } }), undefined);
  for (const value of [NaN, Infinity]) assert.equal(coarseBand(value, 1, 5), null);
  assert.equal(coarseBand(3, 3, 3), null);
});
test("accessible chart announces each band and does not connect missing axes", () => {
  const profile = estimatedModelProfile(model("gpt-6.1-sol"));
  const complete = html(EstimatedModelDiamond, { profile });
  assert.match(complete, /role="img"/); assert.match(complete, /Higher is better/); assert.match(complete, /<polygon/);
  const partial = html(EstimatedModelDiamond, { profile: { ...profile, scores: { ...profile.scores, value: null } } });
  assert.match(partial, /Value unavailable/); assert.doesNotMatch(partial, /<polygon/); assert.match(partial, />—</);
  assert.equal(html(EstimatedModelDiamond, { profile: { ...profile, scores: { ...profile.scores, speed: 6 } } }), "");
});
test("Auto illustrates an adaptive range without assigning a score or observed routing performance",()=>{
  const result=html(AutoModelRange,{});
  assert.match(result,/Illustrative capability range/);assert.match(result,/can span 1 to 5/);
  assert.match(result,/No model score or observed routing performance is shown/);
  assert.match(result,/motion-reduce:hidden/);assert.match(result,/<animate/);
  assert.doesNotMatch(result,/Estimated model profile| of 5/);
});
test("optional source details provide attribution, domain, tested effort and cost basis without credit claims", () => {
  const text = html(EstimatedProfileSources, { profile: estimatedModelProfile(model("gpt-6.1-sol")) });
  assert.match(text, /Arena text preferences|web-development preferences/); assert.match(text, /CC BY 4.0/);
  assert.match(text, /OpenAI medium/); assert.match(text, /10k uncached input/); assert.doesNotMatch(text, /credits|tokens\/sec/);
});
