import test from "node:test";
import assert from "node:assert/strict";
import { exportRobloxUi, uiLayoutSchema, UiExportError } from "../src/lib/ui-library/layout.ts";

function dim(xScale = 0, xOffset = 0, yScale = 0, yOffset = 0) {
  return { xScale, xOffset, yScale, yOffset };
}

function node(overrides = {}) {
  return {
    id: "root",
    parentId: null,
    className: "Frame",
    name: "Root",
    position: dim(0, 0, 0, 0),
    size: dim(1, 0, 1, 0),
    anchorPoint: { x: 0, y: 0 },
    backgroundColor: [0, 0, 0],
    backgroundTransparency: 0,
    zIndex: 1,
    ...overrides,
  };
}

function layout(nodes, overrides = {}) {
  return { version: 1, name: "Sample", nodes, ...overrides };
}

function label(overrides = {}) {
  return node({ className: "TextLabel", text: "Hello", ...overrides });
}

// Decodes the byte-safe Luau literal emitted by the exporter so a test can
// prove arbitrary text survives escaping unchanged (and inertly).
function decodeLuauString(literal) {
  assert.match(literal, /^".*"$/s, "expected a quoted literal");
  const body = literal.slice(1, -1);
  const bytes = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") {
      const escape = body.slice(index + 1, index + 4);
      assert.match(escape, /^\d{3}$/, `unexpected escape in ${literal}`);
      bytes.push(Number(escape));
      index += 3;
      continue;
    }
    const code = char.charCodeAt(0);
    assert.ok(code >= 0x20 && code <= 0x7e, "raw byte outside printable ASCII");
    bytes.push(code);
  }
  return Buffer.from(bytes).toString("utf8");
}

function literalFor(snippet, member) {
  const escaped = member.replace(/\./g, "\\.");
  const match = snippet.match(new RegExp(`${escaped} = ("(?:[^"\\\\]|\\\\.)*")`));
  assert.ok(match, `no literal assignment for ${member}`);
  return match[1];
}

test("a valid layout passes the schema and matches the contract shape", () => {
  const parsed = uiLayoutSchema.parse(layout([node(), label({ id: "title", parentId: "root" })]));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.nodes[1].parentId, "root");
});

test("children are emitted in parent-first topological order regardless of input order", () => {
  const snippet = exportRobloxUi(layout([
    node({ id: "child", parentId: "root", name: "Child" }),
    node({ id: "root", name: "Root" }),
  ]), {});
  const rootAt = snippet.indexOf('node1.Name = "Root"');
  const childAt = snippet.indexOf('node2.Name = "Child"');
  assert.ok(rootAt !== -1 && childAt !== -1 && rootAt < childAt, "parent must be created before its child");
  assert.match(snippet, /node2\.Parent = node1\n/);
  assert.match(snippet, /node1\.Parent = screenGui\n/);
});

test("deep chains still resolve parents before children", () => {
  const snippet = exportRobloxUi(layout([
    node({ id: "c", parentId: "b" }),
    node({ id: "a" }),
    node({ id: "b", parentId: "a" }),
  ]), {});
  const a = snippet.indexOf("node1.Name");
  const b = snippet.indexOf("node2.Name");
  const c = snippet.indexOf("node3.Name");
  assert.ok(a < b && b < c);
  assert.match(snippet, /node2\.Parent = node1\n/);
  assert.match(snippet, /node3\.Parent = node2\n/);
});

test("missing parents, self-parents and cycles are rejected", () => {
  assert.throws(() => exportRobloxUi(layout([node({ parentId: "ghost" })]), {}));
  assert.throws(() => exportRobloxUi(layout([node({ parentId: "root" })]), {}));
  assert.throws(() => exportRobloxUi(layout([
    node({ id: "a", parentId: "b" }),
    node({ id: "b", parentId: "a" }),
  ]), {}));
});

test("unknown classes, unknown fields and non-layout code are rejected", () => {
  assert.throws(() => uiLayoutSchema.parse(layout([node({ className: "Script" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([{ ...node(), script: "print('x')" }])));
  assert.throws(() => uiLayoutSchema.parse(layout([node()], { loadstring: "x" })));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ className: "Frame", text: "nope" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ className: "Frame", imageKey: "pic" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([label({ text: undefined })])));
});

test("slugs, bounds and numeric ranges are enforced", () => {
  assert.throws(() => uiLayoutSchema.parse(layout([node({ id: "Bad Id" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ id: "-lead" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ imageKey: "https://evil.example/x.png" })], { name: "Sample" })));
  assert.throws(() => uiLayoutSchema.parse(layout([], { name: "Sample" }))); // 0 nodes
  assert.throws(() => uiLayoutSchema.parse(layout([node()], { name: "x".repeat(81) })));
  assert.throws(() => uiLayoutSchema.parse(layout(Array.from({ length: 101 }, (_, index) => node({ id: `n${index}` })))));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ position: dim(3, 0, 0, 0) })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ size: dim(-1, 0, 0, 0) })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ anchorPoint: { x: 1.5, y: 0 } })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ backgroundColor: [256, 0, 0] })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ backgroundColor: [1.5, 0, 0] })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ backgroundTransparency: 1.1 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ zIndex: 0 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ zIndex: 101 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ cornerRadius: 129 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([label({ textSize: 9 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([label({ textSize: 101 })])));
  assert.throws(() => uiLayoutSchema.parse(layout([label({ text: "x".repeat(1001) })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ name: "nul\u0000byte" })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ backgroundColor: [0, 0] })])));
  assert.throws(() => uiLayoutSchema.parse(layout([node({ position: dim(0, Number.POSITIVE_INFINITY, 0, 0) })])));
});

test("at most twelve distinct image keys are allowed", () => {
  const many = Array.from({ length: 13 }, (_, index) => node({
    id: `img${index}`, className: "ImageLabel", imageKey: `pic${index}`,
  }));
  assert.throws(() => uiLayoutSchema.parse(layout(many)));
});

test("arbitrary names and text are escaped as inert UTF-8 byte strings", () => {
  const name = 'Say "hi" \\ 你好\nnext';
  const text = '"] .. os.execute("rm -rf /") .. "--\n\ttab';
  const snippet = exportRobloxUi(layout([
    label({ id: "title", name, text }),
  ]), {});
  assert.equal(decodeLuauString(literalFor(snippet, "node1.Name")), name);
  assert.equal(decodeLuauString(literalFor(snippet, "node1.Text")), text);
  // The injected quote never terminates the literal, so the payload stays data.
  assert.ok(!/\.Text = "[^"]*"\s*\.\./.test(snippet), "text must not break out of its literal");
});

test("image keys need safe positive numeric Roblox asset ids", () => {
  const image = layout([node({ id: "hero", className: "ImageLabel", imageKey: "hero-art" })]);
  assert.throws(() => exportRobloxUi(image, {}), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": "https://evil.example/x.png" }), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": "rbxassetid://123" }), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": 0 }), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": -5 }), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": 1.5 }), UiExportError);
  assert.throws(() => exportRobloxUi(image, { "hero-art": Number.MAX_SAFE_INTEGER + 2 }), UiExportError);
  const snippet = exportRobloxUi(image, { "hero-art": 9876543210 });
  assert.match(snippet, /node1\.Image = "rbxassetid:\/\/9876543210"\n/);
});

test("the export is deterministic and shaped like the documented static snippet", () => {
  const sample = layout([
    node({ id: "root", name: "Panel", cornerRadius: 12 }),
    label({ id: "title", parentId: "root", text: "Play", textColor: [255, 255, 255], textSize: 24 }),
    node({ id: "hero", parentId: "root", className: "ImageLabel", imageKey: "hero-art" }),
  ]);
  const first = exportRobloxUi(sample, { "hero-art": 42 });
  const second = exportRobloxUi(sample, { "hero-art": 42 });
  assert.equal(first, second);

  assert.match(first, /^-- Romanum UI library export\./);
  assert.match(first, /local screenGui = Instance\.new\("ScreenGui"\)/);
  assert.match(first, /screenGui\.IgnoreGuiInset = true/);
  assert.match(first, /screenGui\.ResetOnSpawn = false/);
  assert.match(first, /node1\.Position = UDim2\.new\(0, 0, 0, 0\)/);
  assert.match(first, /node1\.AnchorPoint = Vector2\.new\(0, 0\)/);
  assert.match(first, /node1\.BackgroundColor3 = Color3\.fromRGB\(0, 0, 0\)/);
  assert.match(first, /corner1\.CornerRadius = UDim\.new\(0, 12\)/);
  assert.match(first, /corner1\.Parent = node1/);
  assert.match(first, /node2\.Text = "Play"/);
  assert.match(first, /node2\.TextColor3 = Color3\.fromRGB\(255, 255, 255\)/);
  assert.match(first, /node2\.TextSize = 24/);
  assert.match(first, /node3\.Image = "rbxassetid:\/\/42"/);
  assert.match(first, /return screenGui\n$/);
  assert.ok(!first.includes("screenGui.Parent"), "the export must not parent to a player's UI");
});

test("the emitted snippet contains no execution or network surface", () => {
  const snippet = exportRobloxUi(layout([node(), label({ id: "title", parentId: "root" })]), {});
  for (const forbidden of ["loadstring", "HttpGet", "HttpService", "require", "os.execute", "game:", "Instance.new(\"Script\")"]) {
    assert.ok(!snippet.includes(forbidden), `snippet must not contain ${forbidden}`);
  }
});
