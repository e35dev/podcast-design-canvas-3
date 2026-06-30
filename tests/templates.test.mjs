// tests/templates.test.mjs — saved show template layout geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const T = PDC.templates;

test("createTemplate stores clamped rects and returns a stable id", () => {
  T.resetStore();
  const template = T.createTemplate("My Show", {
    host: { x: 0, y: 0, w: 60, h: 100 },
    guest1: { x: 65, y: 55, w: 30, h: 40 },
  });
  assert.equal(template.name, "My Show");
  assert.ok(template.id.includes("my-show"));
  assert.deepEqual(template.rects.host, { x: 0, y: 0, w: 60, h: 100 });
  assert.equal(T.getTemplate(template.id).name, "My Show");
});

test("clampRect keeps rects in stage bounds with a minimum size", () => {
  const rect = T.clampRect({ x: 95, y: 95, w: 20, h: 20 });
  assert.ok(rect.x + rect.w <= 100.001);
  assert.ok(rect.y + rect.h <= 100.001);
  assert.ok(rect.w >= T.MIN_SIZE);
  assert.ok(rect.h >= T.MIN_SIZE);
});

test("rectsForBuckets returns one rect per assigned speaker in order", () => {
  T.resetStore();
  const template = T.createTemplate("Three Up", {
    host: { x: 0, y: 0, w: 100, h: 34 },
    guest1: { x: 0, y: 34, w: 100, h: 33 },
    guest2: { x: 0, y: 67, w: 100, h: 33 },
  });
  const rects = T.rectsForBuckets(template.id, ["host", "guest1"]);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], template.rects.host);
  assert.deepEqual(rects[1], template.rects.guest1);
  assert.equal(T.hasCompleteLayout(template.id, ["host", "guest1"]), true);
});
