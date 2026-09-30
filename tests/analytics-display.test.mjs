import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the actual TSX components and context defaults. This loader only
// resolves/transpiles repository sources; Next/React use their installed code.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const sourceUrl = pathToFileURL(root).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link" || specifier === "next/image") return nextResolve(`${specifier}.js`, context);
    if (specifier.startsWith("@/") || (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith("."))) {
      const base = specifier.startsWith("@/") ? path.resolve(root, specifier.slice(2)) : fileURLToPath(new URL(specifier, context.parentURL));
      const candidate = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
        .find(file => existsSync(file) && statSync(file).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceUrl) && /\.tsx?$/.test(url)) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { GenresTable } = await import("../src/components/analytics/genres-table.tsx");
const { RevenueProvider } = await import("../src/components/analytics/revenue.tsx");
const { GameExplorer } = await import("../src/components/analytics/game-explorer.tsx");
const { ChartInvitation } = await import("../src/components/analytics/chart-invitation.tsx");
hooks.deregister();
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("Genres defaults to player counts and player shares, without estimated currency", () => {
  const markup = renderToStaticMarkup(React.createElement(RevenueProvider, null, React.createElement(GenresTable, {
    genres: [{ name: "Simulation", gameCount: 2, players: 1234, share: 0.5 }],
  })));
  assert.match(markup, />Players now<\/th>/);
  assert.match(markup, />1\.2K<\/td>/);
  assert.match(markup, />Share of players<\/th>/);
  assert.match(markup, />50\.0%<\/td>/);
  assert.doesNotMatch(markup, /Est\. earnings|Robux estimated|USD estimated/);
  assert.match(render(GenresTable, { genres: [] }), /role="status"[^>]*>No genres found\./);
});

test("Games and Charts retain their explorers without a duplicate AI creation button", () => {
  for (const chartMode of [false, true]) {
    const markup = render(GameExplorer, { games: [], chartMode });
    assert.match(markup, chartMode ? /aria-label="Chart builder"/ : /aria-label="Game explorer"/);
    assert.match(markup, /aria-label="Filter games"/);
    assert.doesNotMatch(markup, /Create with AI/);
  }
});

test("the independent Ask Romanum chart invitation remains available when connected", () => {
  const markup = render(ChartInvitation, { connected: true });
  assert.match(markup, /Ask AI to create a chart<\/button>/);
  assert.doesNotMatch(markup, /disabled=""/);
  assert.match(markup, /href="\/analytics\?view=charts"/);
  assert.match(render(ChartInvitation, { connected: false }), /disabled=""/);
});
