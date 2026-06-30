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

test("split preset lays out three speakers with Host on the left and guests stacked on right", () => {
  const rects = getPreset("split").layout(3);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 50, h: 100 });
  assert.deepEqual(rects[1], { x: 50, y: 0, w: 50, h: 50 });
  assert.deepEqual(rects[2], { x: 50, y: 50, w: 50, h: 50 });
});

test("spotlight preset keeps the host primary and two PiP guests for three speakers", () => {
  const rects = getPreset("spotlight").layout(3);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(rects[1].w < 50 && rects[1].h < 50, "guest1 should be inset");
  assert.ok(rects[2].w < 50 && rects[2].h < 50, "guest2 should be inset");
  assert(rects[2].y < rects[1].y, "guest2 should stack above guest1 with fixed inset order");
});

test("stack preset keeps three equal rows for 3 speakers", () => {
  const rects = getPreset("stack").layout(3);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 33.333333333333336 });
  assert.ok(Math.abs(rects[1].y - 33.333333333333336) < 1e-9);
  assert.ok(Math.abs(rects[2].y - 66.66666666666667) < 1e-9);
});

test("stack preset gives each speaker a full-width row", () => {
  const rects = getPreset("stack").layout(2);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(rects[1], { x: 0, y: 50, w: 100, h: 50 });
});
