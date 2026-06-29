// tests/presets.test.js — preset layout composition: rects per speaker count.
const assert = require("assert");
const Presets = require("../app/presets.js");

// There are multiple presets across layouts and pacings.
assert.ok(Presets.PRESETS.length >= 3, "at least 3 presets");
const layouts = new Set(Presets.PRESETS.map((p) => p.layout));
assert.ok(layouts.has("side-by-side") && layouts.has("stacked") && layouts.has("grid"));

function rectsCover(rects) {
  // Every rect normalized and within bounds.
  for (const r of rects) {
    assert.ok(r.x >= 0 && r.x <= 1, "x in range");
    assert.ok(r.y >= 0 && r.y <= 1, "y in range");
    assert.ok(r.w > 0 && r.x + r.w <= 1 + 1e-9, "w fits");
    assert.ok(r.h > 0 && r.y + r.h <= 1 + 1e-9, "h fits");
  }
}

// Single speaker → full frame for any layout.
for (const p of Presets.PRESETS) {
  const r = Presets.composeLayout(p, 1);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { x: 0, y: 0, w: 1, h: 1 });
}

// side-by-side: 2 speakers → two equal columns.
{
  const r = Presets.composeLayout("studio-sidebyside-calm", 2);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepStrictEqual(r[1], { x: 0.5, y: 0, w: 0.5, h: 1 });
  rectsCover(r);
}

// stacked: 3 speakers → three equal rows.
{
  const r = Presets.composeLayout("spotlight-stacked-balanced", 3);
  assert.strictEqual(r.length, 3);
  assert.ok(Math.abs(r[0].h - 1 / 3) < 1e-9);
  assert.deepStrictEqual(r[0].x, 0);
  assert.deepStrictEqual(r[0].w, 1);
  assert.ok(Math.abs(r[2].y - 2 / 3) < 1e-9);
  rectsCover(r);
}

// grid: 4 speakers → 2x2.
{
  const r = Presets.composeLayout("roundtable-grid-energetic", 4);
  assert.strictEqual(r.length, 4);
  const xs = new Set(r.map((x) => x.x));
  const ys = new Set(r.map((x) => x.y));
  assert.strictEqual(xs.size, 2);
  assert.strictEqual(ys.size, 2);
  rectsCover(r);
}

// grid: 2 speakers → 2-up (two columns).
{
  const r = Presets.composeLayout("roundtable-grid-energetic", 2);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { x: 0, y: 0, w: 0.5, h: 1 });
  rectsCover(r);
}

// pacing maps to a real seconds-per-cut hint.
assert.strictEqual(Presets.pacingSeconds("calm"), 12);
assert.strictEqual(Presets.pacingSeconds("energetic"), 4);

// Unknown preset throws.
assert.throws(() => Presets.composeLayout("nope", 2));

console.log("presets.test.js: all assertions passed");
