import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { resolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data.js";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const sourceUrl = pathToFileURL(root).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") return nextResolve("next/link.js", context);
    if (specifier.startsWith("@/") || (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith("."))) {
      const base = specifier.startsWith("@/") ? path.resolve(root, specifier.slice(2)) : fileURLToPath(new URL(specifier, context.parentURL));
      const candidate = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(file => existsSync(file) && statSync(file).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceUrl) && /\.tsx?$/.test(url)) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return nextLoad(url, context);
  },
});
const { analyticsPageMetadata, publicGameMetadata, utcObservationTime, publicSitemapEntries, loadPublicSitemap, PUBLIC_ORIGIN, MAX_SITEMAP_GAMES, PUBLIC_GUIDE_LINKS } = await import("../src/lib/public-discovery.ts");
const { default: PublicDataPage, metadata: guideMetadata } = await import("../src/app/analytics/data/page.tsx");
const { SourceContext } = await import("../src/components/analytics/source-context.tsx");
const { default: sitemap } = await import("../src/app/sitemap.ts");
const { historyService } = await import("../src/lib/history/service.ts");
hooks.deregister();

test("sitemap is bounded, deduplicated and rejects ID/URL/XML injection", () => {
  const candidates = [
    { universeId: 123, privateAnalytics: "PRIVATE_REVENUE" }, { universeId: 123 },
    ...[0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "456", "1</loc><url>", "7&days=1", "https://evil.example"].map(universeId => ({ universeId })),
    ...Array.from({ length: 200 }, (_, index) => ({ universeId: index + 1000 })),
  ];
  const entries = publicSitemapEntries(candidates);
  assert.ok(entries.length <= publicSitemapEntries().length + MAX_SITEMAP_GAMES);
  assert.equal(entries.filter(item => item.url.endsWith("/123")).length, 1);
  for (const item of entries) {
    assert.deepEqual(Object.keys(item), ["url"]);
    assert.equal(new URL(item.url).origin, PUBLIC_ORIGIN);
    assert.doesNotMatch(item.url, /profile|projects|chats|auth|credits|plans|api\/|evil|PRIVATE/);
  }
  const xml = resolveSitemap(entries);
  assert.equal((xml.match(/<loc>/g) ?? []).length, entries.length);
  assert.doesNotMatch(xml, /&(?!amp;|quot;|apos;|lt;|gt;)|PRIVATE_REVENUE|<lastmod>|evil|1<\/loc><url>/);
  assert.ok(xml.includes("<loc>https://romanum.dev/analytics?view=trends</loc>"));
});

test("sitemap degrades to the fixed public pages when the public directory is absent or fails", async () => {
  assert.deepEqual(await loadPublicSitemap(async () => ({ available: false, games: [] })), publicSitemapEntries());
  assert.deepEqual(await loadPublicSitemap(async () => { throw new Error("database unavailable"); }), publicSitemapEntries());
  assert.deepEqual(await loadPublicSitemap(async () => ({ games: [] })), publicSitemapEntries());
});

test("actual sitemap route reads only the existing public directory and projects no extra fields", async () => {
  const original = historyService.games;
  let reads = 0;
  try {
    historyService.games = async () => { reads++; return { available: true, games: [{ universeId: 456, name: "Public game", ownerId: "PRIVATE_OWNER", revenue: "PRIVATE_REVENUE", apiKey: "PRIVATE_KEY" }] }; };
    const entries = await sitemap();
    assert.equal(reads, 1);
    assert.ok(entries.some(item => item.url === `${PUBLIC_ORIGIN}/analytics/games/456`));
    assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|ownerId|revenue|apiKey/);
  } finally { historyService.games = original; }
});

test("analytics view metadata has distinct canonical URLs and ignores unapproved input", () => {
  const titles = new Set();
  for (const view of ["overview", "games", "trends", "genres", "charts", "earnings"]) {
    const metadata = analyticsPageMetadata(view);
    titles.add(metadata.title);
    assert.equal(metadata.alternates.canonical, `${PUBLIC_ORIGIN}/analytics${view === "overview" ? "" : `?view=${view}`}`);
    assert.ok(metadata.description.length > 60);
  }
  assert.equal(titles.size, 6);
  for (const input of [undefined, "", "__proto__", "constructor", "games&genre=private", "https://evil.example", ["games", "trends"]]) {
    assert.deepEqual(analyticsPageMetadata(input), analyticsPageMetadata("overview"));
  }
});

test("game metadata uses public identity only and its name is safely rendered", () => {
  const metadata = publicGameMetadata({ universeId: 123, name: 'Eggs & <script>alert("x")</script>', privateAnalytics: "PRIVATE_REVENUE", accountId: "PRIVATE_OWNER" });
  assert.equal(metadata.alternates.canonical, `${PUBLIC_ORIGIN}/analytics/games/123`);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_REVENUE|PRIVATE_OWNER|privateAnalytics|accountId/);
  const html = renderToStaticMarkup(React.createElement("title", null, metadata.title));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("source context preserves actual UTC observations and discloses missing chart coverage", () => {
  const timestamp = "2026-10-01T19:20:21.123+02:00";
  assert.equal(utcObservationTime(timestamp), "2026-10-01 17:20:21 UTC");
  assert.equal(utcObservationTime("unavailable"), null);
  const html = renderToStaticMarkup(React.createElement(SourceContext, {
    analysis: { sampleSize: 12, unavailableCharts: ["top-earning"], privateAnalytics: "PRIVATE_REVENUE" },
    observations: [{ chart: "top-trending", fetchedAt: timestamp }],
  }));
  assert.ok(html.includes(`dateTime="${timestamp}"`));
  assert.ok(html.includes("2026-10-01 17:20:21 UTC"));
  assert.ok(html.includes("12 distinct non-sponsored games"));
  assert.ok(html.includes("Unavailable charts: Top Earning"));
  assert.ok(html.includes('href="/analytics/data"'));
  assert.doesNotMatch(html, /PRIVATE_REVENUE/);
});

test("public guide renders definitions and useful public links without signup or generated results", () => {
  const html = renderToStaticMarkup(React.createElement(PublicDataPage));
  assert.equal(guideMetadata.alternates.canonical, `${PUBLIC_ORIGIN}/analytics/data`);
  for (const { href } of PUBLIC_GUIDE_LINKS) assert.ok(html.includes(`href="${href}"`), href);
  assert.ok(html.includes('href="/api/games/search?q=Brookhaven"'));
  assert.ok(html.includes('href="/api/history/games"'));
  assert.ok(html.includes("universeId=UNIVERSE_ID&amp;days=7"));
  assert.ok(html.includes("Public concurrent players at retrieval; not daily active users."));
  assert.ok(html.includes("requires neither signup nor an MCP installation"));
  assert.ok(html.includes("not zero"));
  assert.ok(html.includes("do not guarantee"));
  assert.doesNotMatch(html, /href="\/(?:profile|projects|chats|auth|credits|plans|api\/linked-games)/);
});
