import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { mcpConnection } from "../src/lib/mcp/connection.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/mcp/connection") return nextResolve(new URL("../src/lib/mcp/connection.ts", import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/components/mcp/connection-card.tsx")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { ConnectionCard } = await import("../src/components/mcp/connection-card.tsx");
hooks.deregister();

test("the actual connection card server-renders a usable canonical URL and enabled copy button", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionCard));
  assert.match(html, /id="mcp-url"[^>]*value="https:\/\/romanum\.dev\/mcp"/);
  assert.match(html, />Copy<|>Copy<!--/);
  assert.doesNotMatch(html, /disabled=""|Local connection|netlify\.app\/mcp/);
});

test("hosted connection pages advertise the canonical endpoint, including unaccepted Netlify aliases", () => {
  for (const origin of ["", "https://romanum.dev", "https://romanumdev.netlify.app", "https://main--romanumdev.netlify.app", "https://deploy-preview-123--romanumdev.netlify.app"]) {
    assert.deepEqual(mcpConnection(origin), { url: "https://romanum.dev/mcp", local: false });
  }
});

test("loopback development keeps its actual scheme and port", () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3190", "http://[::1]:3001", "https://localhost:3443"]) {
    assert.deepEqual(mcpConnection(origin), { url: `${origin}/mcp`, local: true });
  }
});

test("malformed origins and lookalike loopback names cannot become advertised endpoint URLs", () => {
  for (const origin of ["null", "not a URL", "javascript:alert(1)", "https://localhost.evil.example", "https://127.0.0.1.evil.example", "https://user:password@localhost", "ftp://localhost", "http://192.168.1.2:3000"]) {
    assert.deepEqual(mcpConnection(origin), { url: "https://romanum.dev/mcp", local: false });
  }
});
