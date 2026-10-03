import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { publicModels } from "../src/lib/models/readiness.ts";
import { quoteModel } from "../src/lib/models/estimate.ts";
import { CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY } from "../src/lib/credits/pricing-policy.ts";

const url = new URL("../src/components/models/model-preview.tsx", import.meta.url).href;
const estimateUrl = new URL("../src/components/models/estimated-model-card.tsx", import.meta.url).href;
const coinUrl = new URL("../src/components/coin.tsx", import.meta.url).href;
const hooks = registerHooks({resolve(specifier,context,next) {
  return context.parentURL===coinUrl && specifier==="./wordmark-paths" ? next("./wordmark-paths.ts",context) : next(specifier,context);
},load(target, context, next) {
  return target === url || target === estimateUrl || target === coinUrl ? {format:"module",shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(target),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText} : next(target,context);
}});
const {ModelPreview,ModelStatDiamond}=await import(url); hooks.deregister();
const catalog=publicModels({DEEPSEEK_API_KEY:"fixture-only"});
const model=id=>catalog.models.find(value=>value.id===id);
const html=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
// Synthetic values exercise rendering only. No production registry or model claims use them.
const fixture={modelId:"gpt-6.1-sol",kind:"fixture",scores:{reasoning:58,coding:76,speed:92,value:85},source:{title:"Synthetic test fixture",url:"https://example.invalid/fixture",measuredAt:"2026-10-03T00:00:00Z",methodology:"Synthetic shared-scale test data"}};

test("production preview shows sourced coarse estimates and exact token rates without inventing a credit quote",()=>{
  const result=html(ModelPreview,{model:model("gpt-6.1-sol")});
  assert.match(result,/Estimated/);assert.match(result,/Intelligence 4 of 5, Coding 5 of 5, Speed 3 of 5, Value 3 of 5/);
  assert.match(result,/Estimated credits \/ 1M tokens/);assert.match(result,/>500</);assert.match(result,/>2,500</);assert.match(result,/>25</);
  assert.match(result,/Usage and rounding apply/);
  assert.equal((result.match(/<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"/g)??[]).length,3);
  assert.doesNotMatch(result,/Model evaluation|This call|Provider USD|verified|caution/i);
  assert.match(result,/Romanum AI: provider cost \u00d7 2\.5\./);
});
test("fixture ratings require an explicit test render and never populate a production preview",()=>{
  assert.equal(html(ModelStatDiamond,{evaluation:fixture}),"");
  assert.match(html(ModelStatDiamond,{evaluation:fixture,allowFixture:true}),/reasoning 58, coding 76, speed 92, value 85/);
  assert.doesNotMatch(html(ModelPreview,{model:model(fixture.modelId),evaluation:fixture}),/Model evaluation/);
});
test("malformed or unbounded ratings and missing comparison methodology have no chart",()=>{
  for(const score of [NaN,Infinity,-1,101,"90"]){assert.equal(html(ModelStatDiamond,{evaluation:{...fixture,scores:{...fixture.scores,reasoning:score}},allowFixture:true}),"");}
  assert.equal(html(ModelStatDiamond,{evaluation:{...fixture,source:{...fixture.source,methodology:""}},allowFixture:true}),"");
  assert.equal(html(ModelStatDiamond,{evaluation:{...fixture,source:{...fixture.source,url:"javascript:alert(1)"}},allowFixture:true}),"");
});
test("only the actual matching model and rate-card quote contributes request credits",()=>{
  const selected=model("deepseek-flash"),quote=quoteModel(selected.id,{inputTokens:1000,maxInputTokens:2000,outputTokens:500,maxOutputTokens:1000},{at:"2026-10-02T12:30:00Z"});
  assert.match(html(ModelPreview,{model:selected,quote}),/This call.*credits/);
  assert.doesNotMatch(html(ModelPreview,{model:model("gpt-6.1-sol"),quote}),/This call/);
  assert.doesNotMatch(html(ModelPreview,{model:selected,quote:{...quote,rateCardVersion:"older"}}),/This call/);
});
test("estimated profiles retain current pricing and the policy of matching historical quotes",()=>{
  const selected=model("gpt-6.1-sol"),quote={modelId:selected.id,rateCardVersion:selected.rateCardVersion,estimatedCredits:3};
  assert.match(html(ModelPreview,{model:selected,quote:{...quote,pricingPolicyVersion:CURRENT_PRICING_POLICY}}),/Romanum AI: provider cost \u00d7 2\.5\./);
  for(const pricingPolicyVersion of [undefined,LEGACY_PRICING_POLICY]) {
    const result=html(ModelPreview,{model:selected,quote:{...quote,pricingPolicyVersion}});
    assert.match(result,/Estimated/);assert.match(result,/This call/);assert.match(result,/Romanum AI: provider cost \u00d7 1\.65\./);
  }
  const invalid=html(ModelPreview,{model:selected,quote:{...quote,pricingPolicyVersion:"unknown"}});
  assert.doesNotMatch(invalid,/This call/);assert.match(invalid,/Romanum AI: provider cost \u00d7 2\.5\./);
});
test("unsupported image input and invalid prices are not fabricated",()=>{
  assert.doesNotMatch(html(ModelPreview,{model:model("deepseek-v4-pro")}),/>Images</);
  assert.doesNotMatch(html(ModelPreview,{model:{...model("deepseek-flash"),rates:{input:NaN,output:1,cacheRead:0}}}),/Estimated credits \/ 1M tokens|NaN/);
});
test("credit rates retain cheap cache precision and require matching server display metadata",()=>{
  const luna=model("gpt-6-luna"),result=html(ModelPreview,{model:luna});
  assert.match(result,/>25</);assert.match(result,/>125</);assert.match(result,/>2\.5</);
  assert.doesNotMatch(result,/Provider USD|\$0\.10|\$0\.50/);
  for(const creditRateCards of [undefined,[],luna.creditRateCards.map(card=>({...card,rateCardVersion:"older"})),[luna.creditRateCards[0],luna.creditRateCards[0]],luna.creditRateCards.map(card=>({...card,rates:{...card.rates,cacheRead:NaN}}))]) {
    assert.doesNotMatch(html(ModelPreview,{model:{...luna,creditRateCards}}),/Estimated credits \/ 1M tokens/);
  }
  const quote={modelId:luna.id,rateCardVersion:luna.rateCardVersion,estimatedCredits:.001,pricingPolicyVersion:LEGACY_PRICING_POLICY};
  const legacy=html(ModelPreview,{model:luna,quote});assert.match(legacy,/>16\.5</);assert.match(legacy,/>82\.5</);assert.match(legacy,/>1\.65</);
});
