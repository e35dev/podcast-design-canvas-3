// tests/presets.test.mjs — preset layout geometry. The renderer trusts these
// rects to position real <video> elements, so the geometry must be valid and
// in-bounds for the speaker counts the product supports (2 and 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const { PRESETS, getPreset, DEFAULT_PRESET_ID } = PDC.presets;

test("there are at least three named presets with a sane default", () => {
  assert.ok(PRESETS.length >= 3);
  assert.ok(getPreset(DEFAULT_PRESET_ID), "default preset resolves");
  for (const p of PRESETS) {
    assert.ok(p.id && p.name && p.description);
    assert.equal(typeof p.layout, "function");
  }
});

for (const n of [2, 3]) {
  test(`every preset returns ${n} in-bounds rects for ${n} speakers`, () => {
    for (const p of PRESETS) {
      const rects = p.layout(n);
      assert.equal(rects.length, n, `${p.id} should return ${n} rects`);
      for (const r of rects) {
        for (const k of ["x", "y", "w", "h"]) assert.equal(typeof r[k], "number");
        assert.ok(r.w > 0 && r.h > 0, `${p.id} rect has positive size`);
        assert.ok(r.x >= 0 && r.y >= 0, `${p.id} rect origin non-negative`);
        assert.ok(r.x + r.w <= 100.001, `${p.id} rect stays within width`);
        assert.ok(r.y + r.h <= 100.001, `${p.id} rect stays within height`);
      }
    }
  });
}

test("split preset covers the full stage with two equal halves", () => {
  const rects = getPreset("split").layout(2);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 50, h: 100 });
  assert.deepEqual(rects[1], { x: 50, y: 0, w: 50, h: 100 });
});

test("spotlight preset gives the host the full stage and guests a PiP inset", () => {
  const rects = getPreset("spotlight").layout(2);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(rects[1].w < 50 && rects[1].h < 50, "guest is a small inset");
});

test("stack preset gives each speaker a full-width row", () => {
  const rects = getPreset("stack").layout(2);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(rects[1], { x: 0, y: 50, w: 100, h: 50 });
});
