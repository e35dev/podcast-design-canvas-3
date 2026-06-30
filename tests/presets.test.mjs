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

// #41: switching presets must actually transform the live preview, so the three
// shipped presets MUST produce distinct geometry for the speaker counts the
// product supports. If any two presets returned identical rects, a preset switch
// would be a no-op on screen.
const rectsKey = (rects) => JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h]));

for (const n of [2, 3]) {
  test(`split, stack, and spotlight produce pairwise-distinct layouts for ${n} speakers`, () => {
    const split = rectsKey(getPreset("split").layout(n));
    const stack = rectsKey(getPreset("stack").layout(n));
    const spotlight = rectsKey(getPreset("spotlight").layout(n));
    assert.notEqual(split, stack, `split and stack must differ for ${n} speakers`);
    assert.notEqual(split, spotlight, `split and spotlight must differ for ${n} speakers`);
    assert.notEqual(stack, spotlight, `stack and spotlight must differ for ${n} speakers`);
    assert.equal(new Set([split, stack, spotlight]).size, 3, `all three presets must be distinct for ${n} speakers`);
  });

  test(`every speaker has a distinct rect within each preset for ${n} speakers`, () => {
    for (const p of PRESETS) {
      const keys = p.layout(n).map((r) => `${r.x},${r.y},${r.w},${r.h}`);
      assert.equal(new Set(keys).size, n, `${p.id} should place each of ${n} speakers in its own rect`);
    }
  });
}

test("stack preset stacks speakers in full-width rows that change with count", () => {
  const two = getPreset("stack").layout(2);
  assert.deepEqual(two[0], { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(two[1], { x: 0, y: 50, w: 100, h: 50 });
  const three = getPreset("stack").layout(3);
  assert.equal(three.length, 3);
  assert.ok(three.every((r) => r.w === 100), "stack rows are full width");
  assert.ok(three[1].y > three[0].y && three[2].y > three[1].y, "rows descend the stage");
});
