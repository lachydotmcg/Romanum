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

const url = new URL("../src/components/models/model-preview.tsx", import.meta.url).href;
const hooks = registerHooks({load(target, context, next) {
  return target === url ? {format:"module",shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText} : next(target,context);
}});
const {ModelPreview,ModelStatDiamond}=await import(url); hooks.deregister();
const catalog=publicModels({DEEPSEEK_API_KEY:"fixture-only"});
const model=id=>catalog.models.find(value=>value.id===id);
const html=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
// Synthetic values exercise rendering only. No production registry or model claims use them.
const fixture={modelId:"gpt-6.1-sol",kind:"fixture",scores:{reasoning:58,coding:76,speed:92,value:85},source:{title:"Synthetic test fixture",url:"https://example.invalid/fixture",measuredAt:"2026-10-03T00:00:00Z",methodology:"Synthetic shared-scale test data"}};

test("production preview uses catalog capabilities and exact token rates without inventing a rating or credit quote",()=>{
  const result=html(ModelPreview,{model:model("gpt-6.1-sol")});
  assert.match(result,/Text/);assert.match(result,/Tools/);assert.match(result,/Images/);
  assert.match(result,/\$2\.00/);assert.match(result,/\$10\.00/);assert.match(result,/\$0\.10/);
  assert.doesNotMatch(result,/Model evaluation|credits|verified|caution/i);
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
  assert.doesNotMatch(html(ModelPreview,{model:model("gpt-6.1-sol"),quote}),/This call|credits/);
  assert.doesNotMatch(html(ModelPreview,{model:selected,quote:{...quote,rateCardVersion:"older"}}),/This call|credits/);
});
test("unsupported image input and invalid prices are not fabricated",()=>{
  assert.doesNotMatch(html(ModelPreview,{model:model("deepseek-v4-pro")}),/>Images</);
  assert.doesNotMatch(html(ModelPreview,{model:{...model("deepseek-flash"),rates:{input:NaN,output:1,cacheRead:0}}}),/Provider USD|\$NaN/);
});
